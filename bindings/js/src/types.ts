// What passes between Shama's parts as JSON – the same shapes as the Rust core's – and what the
// app gets back.

export type Language = 'en' | 'de' | 'tr' | 'ar' | 'fa';

/** Texts by language code. */
export type Localized<T> = { [language: string]: T };

export type ArgValue = number | string | boolean;

/** A call to one of the app's tools. */
export interface Call {
  tool: string;
  args?: Record<string, ArgValue>;
}

/** One reading of what was said. */
export interface Hypothesis {
  text: string;
  confidence?: number;
}

/** What the app asked, waiting for the next utterance to answer it. */
export type Pending =
  | { kind: 'ask'; call: Call; missing: string }
  | { kind: 'confirm'; calls: Call[] }
  | { kind: 'choose'; candidates: Call[] };

/** The moment an utterance is settled in. */
export interface Turn {
  language: Language;
  contexts?: string[];
  state?: Record<string, ArgValue>;
  pending?: Pending | null;
  appSpeaking?: boolean;
}

export type Outcome =
  | { kind: 'call'; calls: Call[] }
  | { kind: 'ask'; call: Call; missing: string }
  | { kind: 'confirm'; calls: Call[] }
  | { kind: 'unsure'; candidates: Call[] }
  | { kind: 'cancelled' }
  | { kind: 'stopListening' }
  | { kind: 'ignored' };

export type Stage = 'deterministic' | 'local' | 'ai';

export type Why =
  | 'noMatch'
  | 'lowConfidence'
  | 'ambiguous'
  | 'nothingHeard'
  | 'interruptOnly'
  | 'offline'
  | 'aiNotAllowed'
  | 'unavailable'
  | 'timeout'
  | 'invalidReply'
  | 'refused';

/** One stage's part in settling an utterance. */
export interface Step {
  stage: Stage;
  by: string;
  outcome: 'resolved' | 'noMatch' | 'skipped' | 'failed';
  why?: Why;
  ms: number;
}

/** What the stages on the device made of an utterance. */
export interface Settled {
  outcome?: Outcome;
  stage?: Stage;
  trail: Step[];
}

/** An app's tools, the phrases for them, and the values they take. */
export interface Vocabulary {
  tools: Tool[];
  values?: Record<string, Value[]>;
  builtins?: Partial<Record<'yes' | 'no' | 'cancel' | 'stopListening', Localized<string[]>>>;
}

export interface Tool {
  id: string;
  description?: string;
  args?: Record<string, Arg>;
  contexts?: string[];
  confirm?: boolean;
  ai?: boolean;
  interrupt?: boolean;
  phrases?: Phrase[];
}

export type Arg = { required?: boolean; description?: string; ask?: Localized<string> } & (
  | { type: 'number'; min?: number; max?: number }
  | { type: 'value'; of: string }
  | { type: 'text' }
  | { type: 'boolean' }
);

export interface Phrase {
  say: Localized<string[]>;
  args?: Record<string, ArgValue>;
  contexts?: string[];
}

export interface Value {
  id: string;
  say?: Localized<string[]>;
  description?: string;
}

export interface Problem {
  path: string;
  message: string;
}

/** A tool as AI providers describe them. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** What an AI is given: Shama's rules and the app's brief, the words heard framed as data, the tools offered. */
export interface AiRequest {
  system: string;
  message: string;
  tools: ToolSpec[];
  maxCalls: number;
}

/** What an AI answered, before Shama checks it. */
export interface AiReply {
  calls: { tool: string; args?: Record<string, unknown> }[];
  reply?: string;
}

/** An AI's answer after the check. */
export interface Checked {
  outcome?: Outcome;
  reply?: string;
}

export type Unresolved =
  | 'nothingHeard'
  | 'notUnderstood'
  | 'interruptOnly'
  | 'offline'
  | 'aiNotAllowed'
  | 'aiFailed'
  | 'failed';

/** What became of an utterance. `heard` comes along only when the app asked for transcripts. */
export type Result = { trail: Step[]; heard?: Hypothesis[] } & (
  | { kind: 'call'; stage: Stage; calls: Call[]; reply?: string }
  | { kind: 'ask'; stage: Stage; call: Call; missing: string; question?: string }
  | { kind: 'confirm'; stage: Stage; calls: Call[] }
  | { kind: 'unsure'; stage: Stage; candidates: Call[] }
  | { kind: 'reply'; stage: 'ai'; reply: string }
  | { kind: 'cancelled' }
  | { kind: 'stopListening' }
  | { kind: 'ignored' }
  | { kind: 'unresolved'; reason: Unresolved }
);

export type Mode = 'offline' | 'online';
