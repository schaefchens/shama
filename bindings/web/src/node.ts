// Shama in Node, for an app's tests: the core as WASM in-process, hearing texts and recordings – no
// microphone, no recognizer but the recordings' own transcripts, no voice. What an app's
// vocabulary makes of what people say, checked without a device.
import { readFileSync } from 'node:fs';
import { AiError, createShama } from '@schaefchens/shama';
import type { Port, PortEvent, Shama } from '@schaefchens/shama';
import { Core, initSync } from './generated/shama_wasm.js';

let ready = false;

/** A port over the core as WASM, in this process. */
export function createNodePort(): Port {
  if (!ready) {
    initSync({ module: readFileSync(new URL('./generated/shama_wasm_bg.wasm', import.meta.url)) });
    ready = true;
  }
  const core = new Core();
  const listeners = new Set<(event: PortEvent) => void>();
  const emit = (json: string) => {
    for (const event of JSON.parse(json) as PortEvent[]) listeners.forEach((listener) => listener(event));
  };
  return {
    configure: async () => [],
    setVocabulary: async (vocabulary) => JSON.parse(core.setVocabulary(JSON.stringify(vocabulary))),
    setTurn: (turn) => core.setTurn(JSON.stringify(turn)),
    async listen(options) {
      const events =
        options.text !== undefined
          ? core.listenText(JSON.stringify(options), options.text)
          : core.listenFile(JSON.stringify(options), readFileSync(options.file as string), undefined, undefined);
      setTimeout(() => emit(events), 0);
    },
    release: async () => emit(core.release()),
    hold: () => {},
    stop: async () => core.stop(),
    heard: async (id) => JSON.parse(core.heard(id) ?? 'null'),
    forget: (id) => core.forget(id),
    finish: async (call) => JSON.parse(core.finishCall(JSON.stringify(call))),
    aiRequest: async (id, options) => JSON.parse(core.aiRequest(id, JSON.stringify(options)) ?? 'null'),
    deviceAiAvailable: async () => false,
    deviceAi: async () => {
      throw new AiError('unavailable', 'no device model in Node');
    },
    async checkReply(reply, options) {
      const checked = JSON.parse(core.checkReply(JSON.stringify(reply), JSON.stringify(options)));
      if (checked.why) throw new AiError(checked.why, 'the reply did not hold up');
      return checked;
    },
    speak: async () => {},
    stopSpeaking: () => {},
    online: async () => true,
    requestPermission: async () => true,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Shama in Node: `start({ language, text })` settles a text, `start({ language, file })` a recording. */
export const createNodeShama = (): Shama => createShama(createNodePort());
