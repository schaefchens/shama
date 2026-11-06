// Shama's worker: the core as WASM, the embedded recognizer, and the microphone's audio, which
// comes here from the AudioWorklet directly. What was heard stays here until the page asks for it.

import init, { Core } from './generated/shama_wasm.js';

/** The embedded recognizer, from the module the page names – sherpa-onnx's WASM, say. */
export interface Engine {
  name: string;
  languages: string[];
  /** The readings of 16 kHz audio as JSON: `[{ "text": …, "confidence": … }]`. */
  recognize(language: string, bias: string, audio: Float32Array): string;
}

export interface EngineModule {
  createEngine(models: Record<string, string>): Promise<Engine>;
}

let core: Promise<Core> | null = null;
let engine: Engine | null = null;
let audio: MessagePort | null = null;
let held = false;

function loaded(): Promise<Core> {
  core ??= init().then(() => new Core());
  return core;
}

function post(json: string): void {
  const events = JSON.parse(json) as unknown[];
  if (events.length > 0) postMessage({ type: 'events', events });
}

function recognize(language: string, bias: string, samples: Float32Array): string {
  if (!engine) throw new Error('no embedded recognizer');
  return engine.recognize(language, bias, samples);
}

async function handle(method: string, args: unknown[]): Promise<unknown> {
  const c = await loaded();
  switch (method) {
    case 'configure': {
      const [url, models] = args as [string | null, Record<string, string>];
      engine = url ? await ((await import(/* @vite-ignore */ url)) as EngineModule).createEngine(models) : null;
      return engine?.languages ?? [];
    }
    case 'setVocabulary':
      return JSON.parse(c.setVocabulary(args[0] as string));
    case 'setTurn':
      c.setTurn(args[0] as string);
      return null;
    case 'listen': {
      const [options, rate, port] = args as [string, number, MessagePort];
      // Without a recognizer, the microphone still opens for diagnostics: utterances are cut, and fail.
      const diagnosing = (JSON.parse(options) as { diagnostics?: boolean }).diagnostics === true;
      if (!engine && !diagnosing) throw new Error('no recognizer for the microphone here: configure an embedded engine');
      c.listen(options, rate, engine?.name ?? 'none', recognize);
      held = false;
      audio = port;
      audio.onmessage = (message: MessageEvent<Float32Array>) => {
        if (!held) post(c.push(message.data));
        message.data.fill(0);
      };
      return null;
    }
    case 'listenFile': {
      const [options, url] = args as [string, string];
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const events = c.listenFile(options, bytes, engine?.name, engine ? recognize : undefined);
      bytes.fill(0);
      // After the reply: the page is listening by then.
      setTimeout(() => post(events), 0);
      return null;
    }
    case 'listenText': {
      const events = c.listenText(args[0] as string, args[1] as string);
      setTimeout(() => post(events), 0);
      return null;
    }
    case 'release':
      post(c.release());
      return null;
    case 'hold':
      held = args[0] as boolean;
      return null;
    case 'stop':
      audio?.close();
      audio = null;
      c.stop();
      return null;
    case 'heard':
      return c.heard(args[0] as number) ?? null;
    case 'forget':
      c.forget(args[0] as number);
      return null;
    case 'recordingAudio':
      return c.recordingAudio(args[0] as number) ?? null;
    case 'recordingWav':
      return c.recordingWav(args[0] as number) ?? null;
    case 'forgetRecordings':
      c.forgetRecordings();
      return null;
    case 'finishCall':
      return c.finishCall(args[0] as string);
    case 'aiRequest':
      return c.aiRequest(args[0] as number, args[1] as string) ?? null;
    case 'checkReply':
      return c.checkReply(args[0] as string, args[1] as string);
    default:
      throw new Error(`no method ${method}`);
  }
}

self.onmessage = async (message: MessageEvent<{ id: number; method: string; args: unknown[] }>) => {
  const { id, method, args } = message.data;
  try {
    postMessage({ type: 'reply', id, value: await handle(method, args) });
  } catch (error) {
    postMessage({ type: 'reply', id, error: error instanceof Error ? error.message : String(error) });
  }
};
