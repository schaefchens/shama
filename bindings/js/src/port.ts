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
  /** Tell where audio comes from, the meter in full and each utterance as it is cut. */
  diagnostics?: boolean;
  /** Keep the last utterances' audio, in memory, to be played back or saved – for debugging only. */
  keepAudio?: boolean;
  /** Debug builds: audio from a WAV file instead of the microphone. */
  file?: string;
  /** Tests: a text settled as if it had been heard, without audio. */
  text?: string;
}

/** Where audio comes from, as the platform tells it. */
export interface InputInfo {
  /** The microphone as the system names it – or "file". */
  device: string;
  kind: 'builtIn' | 'wired' | 'bluetooth' | 'usb' | 'file' | 'other';
  /** The rate audio comes at, before Shama resamples it to 16 kHz. */
  rate: number;
  channels: number;
  /** How the system was asked to treat it: the audio session's mode, the recording source, the constraints. */
  processing: string;
  echoCancellation: boolean;
  /** Anything more the platform tells: latency, gain, the output route… */
  details?: Record<string, string | number | boolean>;
}

/** The microphone as Shama's endpointer hears it, about 17 times a second. */
export interface Meter {
  /** 0 to 1, for -60 to 0 dBFS. */
  level: number;
  rmsDb: number;
  /** The loudest sample since the last meter; whether it was at full scale. */
  peakDb: number;
  clipped: boolean;
  /** The room's noise floor, and the loudness above it that counts as speech. */
  floorDb: number;
  thresholdDb: number;
  phase: 'settling' | 'waiting' | 'speaking' | 'done';
}

/** What ended an utterance: a pause, its length, the talk button let go, the audio's end. */
export type Cut = 'pause' | 'long' | 'release' | 'end';

/** An utterance as the endpointer cut it, before it is recognized; `kept`: its audio is kept. */
export interface UtteranceCut {
  id: number;
  startMs: number;
  endMs: number;
  speechMs: number;
  cut: Cut;
  kept: boolean;
}

/** A recording saved: where it is – a file on a device, a link in a browser – and its name. */
export interface SavedRecording {
  uri: string;
  name: string;
}

export type PortEvent =
  | { event: 'level'; level: number }
  /** With diagnostics, in place of the level. */
  | ({ event: 'meter' } & Meter)
  /** With diagnostics: where audio comes from, when listening starts and when its route changes. */
  | { event: 'input'; input: InputInfo }
  | { event: 'speech' }
  /** With diagnostics: an utterance cut, before it is recognized. */
  | ({ event: 'utterance' } & UtteranceCut)
  | { event: 'recognizing' }
  | { event: 'settled'; id: number; recognizer: string; speechMs: number; recognizeMs?: number; settled: Settled; heard?: Hypothesis[] }
  | { event: 'tooShort'; speechMs?: number }
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
  /** Plays an utterance's kept audio; resolves when it has played. */
  playRecording(id: number): Promise<void>;
  stopPlaying(): void;
  /** Saves an utterance's kept audio as a WAV: a file in the app's storage, a link in a browser. */
  saveRecording(id: number): Promise<SavedRecording>;
  /** Wipes the kept audio. */
  forgetRecordings(): void;
  /** Shama's own voice, for its replies in LIVE; resolves when it has spoken. */
  speak(text: string, language: Language): Promise<void>;
  stopSpeaking(): void;
  online(): Promise<boolean>;
  requestPermission(): Promise<boolean>;
  subscribe(listener: (event: PortEvent) => void): () => void;
}
