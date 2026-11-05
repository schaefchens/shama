// The browser's port: the page talks to Shama's worker, which holds the core and the audio; the
// page has the microphone's stream, the voices and the built-in model.

import { AiError, createShama } from '@schaefchens/shama';
import type { Checked, Language, LanguageSupport, Port, PortEvent, Shama } from '@schaefchens/shama';
import { startCapture } from './capture.ts';
import type { Capture } from './capture.ts';
import { modelAvailable, modelDecide, speak, stopSpeaking } from './device.ts';

export interface WebPortOptions {
  /** A module the worker imports for the embedded recognizer: it exports `createEngine(models)`. */
  engine?: string;
  /** A worker of the app's own making, if its bundler wants it so. */
  worker?: Worker;
}

export function createWebPort(options: WebPortOptions = {}): Port {
  const worker = options.worker ?? new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const listeners = new Set<(event: PortEvent) => void>();
  let nextId = 1;
  let capture: Capture | null = null;

  const emit = (event: PortEvent) => listeners.forEach((listener) => listener(event));

  worker.onmessage = (message: MessageEvent) => {
    const data = message.data as { type: 'reply'; id: number; value?: unknown; error?: string } | { type: 'events'; events: PortEvent[] };
    if (data.type === 'events') {
      data.events.forEach(emit);
      return;
    }
    const pending = waiting.get(data.id);
    if (!pending) return;
    waiting.delete(data.id);
    if (data.error !== undefined) pending.reject(new Error(data.error));
    else pending.resolve(data.value);
  };

  function call<T>(method: string, args: unknown[] = [], transfer: Transferable[] = []): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ id, method, args }, transfer);
    });
  }

  function stopCapture(): void {
    capture?.stop();
    capture = null;
  }

  // Foreground only: a hidden page stops listening.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && capture) {
        stopCapture();
        emit({ event: 'interrupted', reason: 'background' });
      }
    });
  }

  const port: Port = {
    async configure({ models }) {
      const embedded = await call<string[]>('configure', [options.engine ?? null, models ?? {}]);
      const languages: Language[] = ['en', 'de', 'tr', 'ar', 'fa'];
      return Promise.all(
        languages.map(async (language): Promise<LanguageSupport> => ({
          language,
          recognizer: embedded.includes(language) ? 'embedded' : 'none',
          os: 'unsupported',
          embedded: embedded.includes(language) ? 'installed' : 'missing',
          deviceAi: await modelAvailable(language),
        })),
      );
    },
    setVocabulary: (vocabulary) => call('setVocabulary', [JSON.stringify(vocabulary)]),
    setTurn(turn) {
      void call('setTurn', [JSON.stringify(turn)]);
    },
    async listen(listenOptions) {
      if (listenOptions.file) {
        await call('listenFile', [JSON.stringify(listenOptions), new URL(listenOptions.file, location.href).href]);
        return;
      }
      stopCapture();
      capture = await startCapture({ echoCancellation: listenOptions.echoCancellation ?? false });
      try {
        await call('listen', [JSON.stringify(listenOptions), capture.rate, capture.port], [capture.port]);
      } catch (error) {
        stopCapture();
        throw error;
      }
      if (listenOptions.echoCancellation) emit({ event: 'echoCancellation', available: capture.echoCancellation });
    },
    async release() {
      await call('release');
      stopCapture();
    },
    hold(paused) {
      void call('hold', [paused]);
    },
    async stop() {
      stopCapture();
      await call('stop');
    },
    async heard(id) {
      const json = await call<string | null>('heard', [id]);
      return json ? JSON.parse(json) : null;
    },
    forget(id) {
      void call('forget', [id]);
    },
    async finish(callToFinish) {
      return JSON.parse(await call<string>('finishCall', [JSON.stringify(callToFinish)]));
    },
    async aiRequest(id, aiOptions) {
      const json = await call<string | null>('aiRequest', [id, JSON.stringify(aiOptions)]);
      return json ? JSON.parse(json) : null;
    },
    deviceAiAvailable: (language) => modelAvailable(language),
    async deviceAi(id, aiOptions) {
      // In a browser the words pass through the page – there is no native side to keep them in.
      const request = await port.aiRequest(id, aiOptions);
      if (!request) throw new AiError('unavailable', 'nothing heard to ask about');
      return modelDecide(request, aiOptions.timeoutMs);
    },
    async checkReply(reply, checkOptions) {
      const checked = JSON.parse(await call<string>('checkReply', [JSON.stringify(reply), JSON.stringify(checkOptions)])) as Checked & {
        why?: AiError['why'];
      };
      if (checked.why) throw new AiError(checked.why, 'the reply did not hold up');
      return checked;
    },
    speak,
    stopSpeaking,
    online: async () => navigator.onLine,
    async requestPermission() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
        return true;
      } catch {
        return false;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return port;
}

/** Shama in the browser. */
export function createWebShama(options: WebPortOptions = {}): Shama {
  return createShama(createWebPort(options));
}
