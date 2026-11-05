// Shama on iOS and Android: the pipeline over the native module, which holds the core, the
// microphone, the system's recognizer and language model, and what was heard.

import { requireNativeModule } from 'expo';
import { AiError, createShama } from '@schaefchens/shama';
import type { AiOptions, Checked, LanguageSupport, Port, PortEvent, Shama, Why } from '@schaefchens/shama';

interface NativeShama {
  configure(models: Record<string, string>): Promise<LanguageSupport[]>;
  setVocabulary(json: string): Promise<string>;
  setTurn(json: string): void;
  listen(json: string): Promise<void>;
  release(): Promise<void>;
  hold(paused: boolean): void;
  stop(): Promise<void>;
  heard(id: number): Promise<string | null>;
  forget(id: number): void;
  finishCall(call: string): Promise<string>;
  aiRequest(id: number, options: string): Promise<string | null>;
  checkReply(reply: string, options: string): Promise<string>;
  deviceAiAvailable(language: string): Promise<boolean>;
  deviceAi(id: number, options: string, timeoutMs: number): Promise<string>;
  speak(text: string, language: string): Promise<void>;
  stopSpeaking(): void;
  online(): Promise<boolean>;
  requestPermission(): Promise<boolean>;
  addListener(event: 'onPortEvent', listener: (payload: { json: string }) => void): { remove(): void };
}

const native = requireNativeModule<NativeShama>('Shama');

const parse = <T>(json: string | null): T | null => (json ? (JSON.parse(json) as T) : null);

const aiOptions = (options: AiOptions) => JSON.stringify({ brief: options.brief, live: options.live, maxCalls: options.maxCalls });

export function createNativePort(): Port {
  const listeners = new Set<(event: PortEvent) => void>();
  native.addListener('onPortEvent', ({ json }) => {
    for (const event of JSON.parse(json) as PortEvent[]) listeners.forEach((listener) => listener(event));
  });
  return {
    configure: ({ models }) => native.configure(models ?? {}),
    setVocabulary: async (vocabulary) => JSON.parse(await native.setVocabulary(JSON.stringify(vocabulary))),
    setTurn: (turn) => native.setTurn(JSON.stringify(turn)),
    listen: (options) => native.listen(JSON.stringify(options)),
    release: () => native.release(),
    hold: (paused) => native.hold(paused),
    stop: () => native.stop(),
    heard: async (id) => parse(await native.heard(id)),
    forget: (id) => native.forget(id),
    finish: async (call) => JSON.parse(await native.finishCall(JSON.stringify(call))),
    aiRequest: async (id, options) => parse(await native.aiRequest(id, aiOptions(options))),
    deviceAiAvailable: (language) => native.deviceAiAvailable(language),
    deviceAi: async (id, options) => JSON.parse(await native.deviceAi(id, aiOptions(options), options.timeoutMs)),
    async checkReply(reply, options) {
      const checked = JSON.parse(await native.checkReply(JSON.stringify(reply), JSON.stringify(options))) as Checked & { why?: Why };
      if (checked.why) throw new AiError(checked.why, 'the reply did not hold up');
      return checked;
    },
    speak: (text, language) => native.speak(text, language),
    stopSpeaking: () => native.stopSpeaking(),
    online: () => native.online(),
    requestPermission: () => native.requestPermission(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Shama on this device. */
export function createNativeShama(): Shama {
  return createShama(createNativePort());
}
