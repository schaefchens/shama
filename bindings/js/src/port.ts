// What a platform gives the pipeline: the microphone, the core, the system's recognizers and
// language model, a voice. React Native implements it natively, the web in a worker; tests fake
// it. What was heard stays behind it until a stage here needs the words.

import type {
  AiReply,
  AiRequest,
  Call,
  Checked,
  Hypothesis,
  Language,
  Localized,
  Outcome,
  Problem,
  Settled,
  Turn,
  Vocabulary,
} from './types.ts';

export type ListenMode = 'tap' | 'hold' | 'continuous';

export interface Endpointing {
  endPauseMs?: number;
  maxUtteranceMs?: number;
  /** Without speech this long, a turn ends; 0 never ends it. */
  nothingHeardMs?: number;
  settleMs?: number;
  minSpeechMs?: number;
  preRollMs?: number;
  postRollMs?: number;
}

export type RecognizerChoice = 'auto' | 'os' | 'embedded';

export interface ListenOptions {
  mode: ListenMode;
  language: Language;
  recognizer?: RecognizerChoice;
  endpointing?: Endpointing;
  /** LIVE: take the app's own voice out of the microphone. */
  echoCancellation?: boolean;
  /** In stage 2, ask back a phrase found inside longer speech. */
  partial?: boolean;
  /** Hand what was heard to the app with every result – for debugging only. */
  transcripts?: boolean;
  /** Debug builds: audio from a WAV file instead of the microphone. */
  file?: string;
  /** Tests: a text settled as if it had been heard, without audio. */
  text?: string;
}

export type PortEvent =
  | { event: 'level'; level: number }
  | { event: 'speech' }
  | { event: 'recognizing' }
  | { event: 'settled'; id: number; recognizer: string; speechMs: number; settled: Settled; heard?: Hypothesis[] }
  | { event: 'tooShort' }
  | { event: 'nothingHeard' }
  | { event: 'done' }
  | { event: 'failed'; message: string }
  /** Whether the app's own voice is taken out of the microphone (LIVE). */
  | { event: 'echoCancellation'; available: boolean }
  /** Listening was cut off: a call, another app taking the microphone, the permission revoked. */
  | { event: 'interrupted'; reason: string };

export interface LanguageSupport {
  language: Language;
  /** The recognizer `auto` picks. */
  recognizer: 'os' | 'embedded' | 'none';
  os: 'ready' | 'downloadable' | 'unsupported';
  embedded: 'installed' | 'missing';
  deviceAi: boolean;
}

export interface AiOptions {
  brief: string;
  live: boolean;
  maxCalls: number;
}

export interface Port {
  /** Embedded models per language – a directory or URL each; what each language can do here. */
  configure(options: { models?: Localized<string> }): Promise<LanguageSupport[]>;
  /** Compiles the vocabulary in the core; its problems, none when it is good. */
  setVocabulary(vocabulary: Vocabulary): Promise<Problem[]>;
  setTurn(turn: Turn): void;
  /** Resolves once the microphone is open. */
  listen(options: ListenOptions): Promise<void>;
  /** The talk button let go. */
  release(): Promise<void>;
  /** LIVE, while the app speaks and there is no echo cancellation: stop and resume taking audio. */
  hold(paused: boolean): void;
  stop(): Promise<void>;
  /** What was heard in an utterance, while it is kept. */
  heard(id: number): Promise<Hypothesis[] | null>;
  forget(id: number): void;
  /** A call made complete in the core: the app's state filled in, a missing argument asked for, a consequential tool confirmed. */
  finish(call: Call): Promise<Outcome>;
  /** The request for an external AI, the words heard framed in it. */
  aiRequest(id: number, options: AiOptions): Promise<AiRequest | null>;
  deviceAiAvailable(language: Language): Promise<boolean>;
  /** The device's own language model, given the words heard there – they don't come here. */
  deviceAi(id: number, options: AiOptions & { timeoutMs: number }): Promise<AiReply>;
  /** Rejects with a `Why` when the reply doesn't hold up. */
  checkReply(reply: AiReply, options: { live: boolean; maxCalls: number; replyChars: number }): Promise<Checked>;
  /** Shama's own voice, for its replies in LIVE; resolves when it has spoken. */
  speak(text: string, language: Language): Promise<void>;
  stopSpeaking(): void;
  online(): Promise<boolean>;
  requestPermission(): Promise<boolean>;
  subscribe(listener: (event: PortEvent) => void): () => void;
}
