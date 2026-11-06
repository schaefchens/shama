// React hooks for Shama – the same on React Native and the web: what it is doing, push-to-talk,
// LIVE, the contexts of the screens mounted, the last one in front – and, for debugging, what the
// microphone and the recognizers do.

import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  ArgValue,
  Call,
  Hypothesis,
  InputInfo,
  LiveOptions,
  LiveState,
  Meter,
  Pending,
  PortEvent,
  Result,
  Shama,
  Stage,
  StartOptions,
  UtteranceCut,
} from '@schaefchens/shama';

const ShamaContext = createContext<Shama | null>(null);

export function ShamaProvider(props: { shama: Shama; children?: ReactNode }) {
  return createElement(ShamaContext.Provider, { value: props.shama }, props.children);
}

export function useShama(): Shama {
  const shama = useContext(ShamaContext);
  if (!shama) throw new Error('useShama needs a ShamaProvider around it');
  return shama;
}

export interface Listening {
  state: 'idle' | 'listening' | 'recognizing' | 'deciding';
  stage?: Stage;
  /** The microphone's level, 0 to 1. */
  level: number;
  live: LiveState;
  /** The last result. */
  result: Result | null;
  /** What Shama asked, waiting for an answer. */
  pending: Pending | null;
}

/** What Shama is doing, for the app to show. */
export function useListening(): Listening {
  const shama = useShama();
  const [listening, setListening] = useState<Listening>(() => ({
    state: 'idle',
    level: 0,
    live: shama.live.state,
    result: null,
    pending: shama.pending,
  }));
  useEffect(() => {
    const update = (change: Partial<Listening>) => setListening((now) => ({ ...now, ...change, pending: shama.pending }));
    const stops = [
      shama.on('state', ({ state, stage }) => update({ state, stage, level: state === 'idle' ? 0 : undefined })),
      shama.on('level', (level) => update({ level })),
      shama.on('live', ({ state }) => update({ live: state })),
      shama.on('result', (result) => update({ result })),
    ];
    return () => stops.forEach((stop) => stop());
  }, [shama]);
  return listening;
}

export interface PushToTalk {
  /** The talk button down: listens until it is let go, or – with `until: 'pause'` – until a pause. */
  press(): Promise<Result | null>;
  /** The talk button let go. */
  release(): Promise<void>;
  cancel(): Promise<void>;
}

export function usePushToTalk(options: StartOptions): PushToTalk {
  const shama = useShama();
  const latest = useRef(options);
  latest.current = options;
  const press = useCallback(async () => {
    try {
      return await shama.start(latest.current);
    } catch (error) {
      if ((error as { code?: string }).code === 'busy') return null;
      throw error;
    }
  }, [shama]);
  const release = useCallback(() => shama.stop(), [shama]);
  const cancel = useCallback(() => shama.cancel(), [shama]);
  return { press, release, cancel };
}

export interface LiveControl {
  state: LiveState;
  start(): Promise<void>;
  stop(): Promise<void>;
  toggle(): Promise<void>;
  /** The app's own voice began or ended. */
  appSpeaking(speaking: boolean): void;
  say(text: string): Promise<void>;
}

export function useLive(options: LiveOptions): LiveControl {
  const shama = useShama();
  const latest = useRef(options);
  latest.current = options;
  const [state, setState] = useState<LiveState>(shama.live.state);
  useEffect(() => shama.on('live', ({ state: next }) => setState(next)), [shama]);
  const start = useCallback(() => shama.live.start(latest.current), [shama]);
  const stop = useCallback(() => shama.live.stop(), [shama]);
  const toggle = useCallback(() => (shama.live.state === 'off' ? shama.live.start(latest.current) : shama.live.stop()), [shama]);
  const appSpeaking = useCallback((speaking: boolean) => shama.live.appSpeaking(speaking), [shama]);
  const say = useCallback((text: string) => shama.live.say(text), [shama]);
  return { state, start, stop, toggle, appSpeaking, say };
}

interface Entry {
  contexts: string[];
  state?: Record<string, ArgValue>;
}

const stacks = new WeakMap<Shama, Entry[]>();

function apply(shama: Shama, stack: Entry[]): void {
  const contexts: string[] = [];
  for (const entry of [...stack].reverse()) {
    for (const context of entry.contexts) if (!contexts.includes(context)) contexts.push(context);
  }
  const state = Object.assign({}, ...stack.map((entry) => entry.state ?? {}));
  shama.setContext({ contexts, state });
}

/** A screen's contexts – and the state that fills unsaid arguments – while it is mounted. */
export function useShamaContext(contexts: string[], state?: Record<string, ArgValue>): void {
  const shama = useShama();
  const entry = useRef<Entry>({ contexts, state });
  const key = JSON.stringify([contexts, state ?? null]);
  useEffect(() => {
    const stack = stacks.get(shama) ?? [];
    stacks.set(shama, stack);
    stack.push(entry.current);
    apply(shama, stack);
    return () => {
      const index = stack.indexOf(entry.current);
      if (index >= 0) stack.splice(index, 1);
      apply(shama, stack);
    };
  }, [shama]);
  useEffect(() => {
    entry.current.contexts = contexts;
    entry.current.state = state;
    const stack = stacks.get(shama);
    if (stack) apply(shama, stack);
    // `key` stands for both: arrays and objects made anew each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shama, key]);
}

/** An utterance as diagnostics tell it: how it was cut, heard and settled. */
export interface UtteranceInfo extends UtteranceCut {
  /** When it was cut: milliseconds since the diagnostics began. */
  at: number;
  recognizer?: string;
  recognizeMs?: number;
  /** What was heard, when the app asked for transcripts. */
  heard?: Hypothesis[];
  result?: Result;
  failed?: string;
}

export interface LogEntry {
  /** Milliseconds since the diagnostics began. */
  at: number;
  text: string;
}

export interface Diagnostics {
  /** Where audio comes from, as last told. */
  input: InputInfo | null;
  meter: Meter | null;
  /** The meter over the last seconds, the oldest first. */
  history: Meter[];
  /** The last utterances, the newest first. */
  utterances: UtteranceInfo[];
  /** What happened, a line each, the newest last – the meter left out. */
  log: LogEntry[];
  clear(): void;
}

export interface DiagnosticsOptions {
  /** How much of the meter's history is kept: 10 s by default. */
  historyMs?: number;
  /** How many utterances: 8 by default, as many as Shama keeps the audio of. */
  utterances?: number;
  /** How many log lines: 300 by default. */
  logLines?: number;
}

/** A meter about every 60 ms. */
const METER_MS = 60;

/**
 * What Shama tells for debugging, gathered for a view: the microphone, the meter and its history,
 * the last utterances, a log. It needs `shama.setDebug({ diagnostics: true })`; results, states
 * and errors are logged either way.
 */
export function useDiagnostics(options: DiagnosticsOptions = {}): Diagnostics {
  const shama = useShama();
  const limits = useRef(options);
  limits.current = options;
  const store = useRef({
    started: Date.now(),
    input: null as InputInfo | null,
    meter: null as Meter | null,
    history: [] as Meter[],
    utterances: [] as UtteranceInfo[],
    log: [] as LogEntry[],
  });
  const [, setVersion] = useState(0);
  const clear = useCallback(() => {
    Object.assign(store.current, { started: Date.now(), history: [], utterances: [], log: [] });
    setVersion((v) => v + 1);
  }, []);
  useEffect(() => {
    const now = store.current;
    const changed = () => setVersion((v) => v + 1);
    const log = (text: string) => {
      now.log = [...now.log, { at: Date.now() - now.started, text }].slice(-(limits.current.logLines ?? 300));
    };
    // Listening over: the last meter stays to be read, no longer waiting or speaking.
    const ended = () => {
      if (now.meter && now.meter.phase !== 'done') now.meter = { ...now.meter, phase: 'done' };
    };
    const utterance = (find: (u: UtteranceInfo) => boolean, change: Partial<UtteranceInfo>) => {
      const index = now.utterances.findIndex(find);
      if (index < 0) return;
      now.utterances = now.utterances.map((u, i) => (i === index ? { ...u, ...change } : u));
    };
    const onEvent = (event: PortEvent) => {
      if (event.event === 'meter') {
        const { event: _, ...meter } = event;
        if (meter.clipped && !now.meter?.clipped) log(`clipping: peak ${meter.peakDb.toFixed(1)} dBFS`);
        now.meter = meter;
        const keep = Math.ceil((limits.current.historyMs ?? 10_000) / METER_MS);
        now.history = [...now.history, meter].slice(-keep);
      } else if (event.event === 'level') {
        return;
      } else {
        if (event.event === 'input') now.input = event.input;
        if (event.event === 'utterance') {
          const { event: _, ...cut } = event;
          const info: UtteranceInfo = { ...cut, at: Date.now() - now.started };
          now.utterances = [info, ...now.utterances].slice(0, limits.current.utterances ?? 8);
        }
        if (event.event === 'settled') {
          utterance((u) => u.id === event.id, { recognizer: event.recognizer, recognizeMs: event.recognizeMs, heard: event.heard });
        }
        if (event.event === 'failed') utterance((u) => !u.recognizer && !u.failed, { failed: event.message });
        if (event.event === 'done' || event.event === 'interrupted') ended();
        log(describeEvent(event));
      }
      changed();
    };
    const stops = [
      shama.on('diagnostic', onEvent),
      shama.on('state', ({ state, stage }) => {
        if (state === 'idle' && shama.live.state === 'off') ended();
        log(stage ? `${state} (${stage})` : state);
        changed();
      }),
      shama.on('live', ({ state, reason }) => {
        if (state === 'off') ended();
        log(reason ? `LIVE ${state}: ${reason}` : `LIVE ${state}`);
        changed();
      }),
      shama.on('result', (result) => {
        utterance((u) => u.recognizer !== undefined && !u.result, { result });
        log(`result: ${describeResult(result)}`);
        changed();
      }),
      shama.on('error', (error) => {
        log(`error (${error.code}): ${error.message}`);
        changed();
      }),
    ];
    return () => stops.forEach((stop) => stop());
  }, [shama]);
  const { input, meter, history, utterances, log } = store.current;
  return { input, meter, history, utterances, log, clear };
}

/** A call as one line: `open(book=moby, chapter=3)`. */
export function describeCall(call: Call): string {
  const args = Object.entries(call.args ?? {})
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(', ');
  return `${call.tool}(${args})`;
}

/** A result as one line. */
export function describeResult(result: Result): string {
  switch (result.kind) {
    case 'call':
      return `${result.calls.map(describeCall).join('; ')} · ${result.stage}${result.reply ? ` · “${result.reply}”` : ''}`;
    case 'ask':
      return `ask ${result.question ?? result.missing} · ${describeCall(result.call)} · ${result.stage}`;
    case 'confirm':
      return `confirm ${result.calls.map(describeCall).join('; ')} · ${result.stage}`;
    case 'unsure':
      return `unsure: ${result.candidates.map(describeCall).join(' or ')} · ${result.stage}`;
    case 'reply':
      return `reply “${result.reply}”`;
    case 'unresolved':
      return `unresolved: ${result.reason}`;
    default:
      return result.kind;
  }
}

/** Where audio comes from, as one line. */
export function describeInput(input: InputInfo): string {
  const rate = input.rate === 16_000 ? '16 kHz' : `${input.rate / 1000} kHz → 16 kHz`;
  const echo = input.echoCancellation ? ' · echo cancelled' : '';
  return `${input.device} (${input.kind}) · ${rate} · ${input.channels} ch · ${input.processing}${echo}`;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

/** A platform's event as one line. */
export function describeEvent(event: PortEvent): string {
  switch (event.event) {
    case 'input':
      return `input: ${describeInput(event.input)}`;
    case 'utterance':
      return `utterance #${event.id}: ${seconds(event.endMs - event.startMs)}, ${seconds(event.speechMs)} of speech, ended by ${event.cut}${event.kept ? ', audio kept' : ''}`;
    case 'settled': {
      const heard = event.heard ? `: ${event.heard.map((h) => `“${h.text}”`).join(' | ')}` : '';
      const ms = event.recognizeMs !== undefined ? ` in ${event.recognizeMs} ms` : '';
      return `#${event.id} heard by ${event.recognizer}${ms}${heard}`;
    }
    case 'tooShort':
      return event.speechMs !== undefined ? `too short for speech: ${event.speechMs} ms` : 'too short for speech';
    case 'nothingHeard':
      return 'nothing heard';
    case 'speech':
      return 'speech begins';
    case 'recognizing':
      return 'recognizing';
    case 'done':
      return 'listening done';
    case 'failed':
      return `failed: ${event.message}`;
    case 'echoCancellation':
      return `echo cancellation ${event.available ? 'on' : 'unavailable'}`;
    case 'interrupted':
      return `interrupted: ${event.reason}`;
    case 'meter':
      return `meter ${event.rmsDb.toFixed(1)} dBFS`;
    case 'level':
      return `level ${event.level.toFixed(2)}`;
  }
}
