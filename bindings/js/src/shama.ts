// The pipeline over a platform's port: push-to-talk turns and LIVE conversations, the stages that
// run after the device's – the app's resolvers, then an AI – each only when the one before
// couldn't settle what was said, and the questions asked in between.

import type { AiProvider } from './ai.ts';
import { AiError } from './ai.ts';
import type { ListenOptions, Endpointing, Port, PortEvent, RecognizerChoice } from './port.ts';
import type {
  ArgValue,
  Call,
  Checked,
  Hypothesis,
  Language,
  Mode,
  Outcome,
  Pending,
  Problem,
  Result,
  Stage,
  Step,
  Turn,
  Unresolved,
  Vocabulary,
  Why,
} from './types.ts';

export type ErrorCode = 'busy' | 'permission' | 'vocabulary' | 'failed' | 'interrupted';

export class ShamaError extends Error {
  readonly code: ErrorCode;
  readonly problems: Problem[];

  constructor(code: ErrorCode, message: string, problems: Problem[] = []) {
    super(message);
    this.name = 'ShamaError';
    this.code = code;
    this.problems = problems;
  }
}

export interface AiLimits {
  timeoutMs: number;
  maxCalls: number;
  replyChars: number;
}

export interface AiSettings {
  /** A few sentences about the app, for the AI: what it is, what its tools are for. */
  brief: string;
  /** The device's own language model, where there is one – offline too. */
  device?: boolean;
  /** An AI the app reaches over the network – online only. */
  external?: AiProvider;
  /** Which to try first. */
  order?: ('device' | 'external')[];
  /** Let an external AI hear LIVE speech, which can be other people's. */
  live?: boolean;
  limits?: Partial<AiLimits>;
}

/** The app's own stage-2 resolver – its search, say: calls, an outcome, or nothing. */
export type Resolver = (input: { heard: Hypothesis[]; turn: Turn }) =>
  | Call[]
  | Outcome
  | null
  | undefined
  | Promise<Call[] | Outcome | null | undefined>;

export interface StartOptions {
  language: Language;
  /** Until the talk button is let go, or until a pause. */
  until?: 'release' | 'pause';
  mode?: Mode;
  /** Whether stage 3 may run for this turn. */
  ai?: boolean;
  recognizer?: RecognizerChoice;
  endpointing?: Endpointing;
  transcripts?: boolean;
  file?: string;
}

export type LiveState = 'off' | 'listening' | 'speaking' | 'interruptOnly' | 'paused';

export type LiveEnd = 'toggle' | 'command' | 'quiet' | 'interrupted' | 'failed';

export interface LiveOptions {
  language: Language;
  /** While the app speaks: listen for its interrupt tools on echo-cancelled input, or pause. */
  whileAppSpeaks?: 'interrupt' | 'pause';
  /** Without speech this long – the app's and Shama's own voice not counted – the conversation ends. 0: never. */
  quietMs?: number;
  mode?: Mode;
  ai?: boolean;
  /** What Shama says to a result; by default its questions and the AI's replies. */
  speak?: (result: Result) => string | null | undefined;
  recognizer?: RecognizerChoice;
  endpointing?: Endpointing;
  transcripts?: boolean;
  file?: string;
}

export interface ShamaEvents {
  /** Before the microphone opens: the app pauses its voice. Awaited up to a second. */
  listeningStart: () => void | Promise<void>;
  state: (state: { state: 'idle' | 'listening' | 'recognizing' | 'deciding'; stage?: Stage }) => void;
  level: (level: number) => void;
  result: (result: Result) => void;
  live: (live: { state: LiveState; reason?: LiveEnd }) => void;
  error: (error: ShamaError) => void;
}

export interface Shama {
  setVocabulary(vocabulary: Vocabulary): Promise<void>;
  /** The app's contexts, the one in front first, and its state for arguments left unsaid. */
  setContext(context: { contexts?: string[]; state?: Record<string, ArgValue> }): void;
  setMode(mode: Mode): void;
  setAi(settings: AiSettings | null): void;
  addResolver(resolver: Resolver, options?: { name?: string; contexts?: string[] }): () => void;
  requestPermission(): Promise<boolean>;
  /** One push-to-talk turn: resolves with what became of it. */
  start(options: StartOptions): Promise<Result>;
  /** The talk button let go. */
  stop(): Promise<void>;
  cancel(): Promise<void>;
  /** Answers a pending confirmation by a button. */
  confirm(yes: boolean): Promise<Result | null>;
  /** Picks a pending choice by a button. */
  choose(index: number): Promise<Result | null>;
  reset(): void;
  readonly pending: Pending | null;
  readonly live: Live;
  on<E extends keyof ShamaEvents>(event: E, listener: ShamaEvents[E]): () => void;
}

export interface Live {
  start(options: LiveOptions): Promise<void>;
  stop(): Promise<void>;
  /** The app's voice began or ended – its reading aloud. */
  appSpeaking(speaking: boolean): void;
  /** Says something in Shama's voice. */
  say(text: string): Promise<void>;
  readonly state: LiveState;
}

const PENDING_MS = 30_000;
const LISTENING_START_MS = 1_000;
const DEFAULT_LIMITS: AiLimits = { timeoutMs: 10_000, maxCalls: 3, replyChars: 300 };
const LIVE_ENDPOINTING: Endpointing = { endPauseMs: 700, nothingHeardMs: 0 };

type SettledEvent = Extract<PortEvent, { event: 'settled' }>;

interface TurnSession {
  kind: 'turn';
  options: StartOptions;
  resolve: (result: Result) => void;
  deciding: boolean;
  finished: boolean;
  abort?: AbortController;
}

interface LiveSession {
  kind: 'live';
  options: LiveOptions;
  /** Whether the app's interrupt tools are listened for while it speaks – false: Shama pauses. */
  interrupting: boolean;
  queue: Promise<void>;
  quiet?: ReturnType<typeof setTimeout>;
  abort?: AbortController;
}

export function createShama(port: Port): Shama {
  let vocabulary: Vocabulary | null = null;
  let language: Language = 'en';
  let contexts: string[] = [];
  let state: Record<string, ArgValue> = {};
  let mode: Mode = 'offline';
  let ai: AiSettings | null = null;
  let pending: { value: Pending; stage: Stage; timer: ReturnType<typeof setTimeout> } | null = null;
  let session: TurnSession | LiveSession | null = null;
  let liveState: LiveState = 'off';
  let appVoice = false;
  let ownVoice = false;
  const resolvers: { resolver: Resolver; name: string; contexts?: string[] }[] = [];
  type Listener = (...args: never[]) => unknown;
  const listeners = new Map<keyof ShamaEvents, Set<Listener>>();

  function emit<E extends keyof ShamaEvents>(event: E, ...args: Parameters<ShamaEvents[E]>): void {
    for (const listener of listeners.get(event) ?? []) {
      (listener as (...a: Parameters<ShamaEvents[E]>) => void)(...args);
    }
  }

  function speakingNow(): boolean {
    return appVoice || ownVoice;
  }

  function turn(): Turn {
    const interrupting = session?.kind === 'live' && session.interrupting && speakingNow();
    return { language, contexts, state, pending: pending?.value ?? null, appSpeaking: interrupting };
  }

  function sync(): void {
    port.setTurn(turn());
  }

  function setPending(value: Pending | null, stage: Stage = 'deterministic'): void {
    if (pending) clearTimeout(pending.timer);
    if (value) {
      const timer = setTimeout(() => setPending(null), PENDING_MS);
      // A question left open doesn't keep a process alive (Node); apps run on regardless.
      (timer as { unref?: () => void }).unref?.();
      pending = { value, stage, timer };
    } else {
      pending = null;
    }
    sync();
  }

  function question(call: Call, missing: string): string | undefined {
    const arg = vocabulary?.tools.find((tool) => tool.id === call.tool)?.args?.[missing];
    return arg?.ask?.[language];
  }

  /** An outcome as the app gets it; what it asks waits for the next utterance. */
  function fromOutcome(outcome: Outcome, stage: Stage, trail: Step[], reply?: string): Result {
    switch (outcome.kind) {
      case 'call':
        setPending(null);
        return { kind: 'call', stage, calls: outcome.calls, reply, trail };
      case 'ask':
        setPending({ kind: 'ask', call: outcome.call, missing: outcome.missing }, stage);
        return { kind: 'ask', stage, call: outcome.call, missing: outcome.missing, question: question(outcome.call, outcome.missing), trail };
      case 'confirm':
        setPending({ kind: 'confirm', calls: outcome.calls }, stage);
        return { kind: 'confirm', stage, calls: outcome.calls, trail };
      case 'unsure':
        setPending({ kind: 'choose', candidates: outcome.candidates }, stage);
        return { kind: 'unsure', stage, candidates: outcome.candidates, trail };
      case 'cancelled':
        setPending(null);
        return { kind: 'cancelled', trail };
      case 'stopListening':
        return { kind: 'stopListening', trail };
      case 'ignored':
        return { kind: 'ignored', trail };
    }
  }

  function fromChecked(checked: Checked, trail: Step[]): Result {
    if (checked.outcome) return fromOutcome(checked.outcome, 'ai', trail, checked.reply);
    if (checked.reply) return { kind: 'reply', stage: 'ai', reply: checked.reply, trail };
    return { kind: 'unresolved', reason: 'aiFailed', trail };
  }

  /** Settles what the device couldn't: the app's resolvers, then an AI. */
  async function decide(event: SettledEvent, live: boolean, options: { mode?: Mode; ai?: boolean }, signal: AbortSignal): Promise<Result> {
    const trail = [...event.settled.trail];
    const withHeard = (result: Result): Result => (event.heard ? { ...result, heard: event.heard } : result);
    try {
      if (event.settled.outcome) {
        return withHeard(fromOutcome(event.settled.outcome, event.settled.stage ?? 'deterministic', trail));
      }
      if (trail.some((step) => step.why === 'nothingHeard')) return withHeard({ kind: 'unresolved', reason: 'nothingHeard', trail });
      const now = turn();
      if (now.appSpeaking) return withHeard({ kind: 'unresolved', reason: 'interruptOnly', trail });

      const offered = resolvers.filter((r) => !r.contexts?.length || r.contexts.some((context) => contexts.includes(context)));
      if (offered.length > 0) {
        emit('state', { state: 'deciding', stage: 'local' });
        const heard = event.heard ?? (await port.heard(event.id)) ?? [];
        for (const { resolver, name } of offered) {
          const started = Date.now();
          const answer = await resolver({ heard, turn: now });
          if (answer && (!Array.isArray(answer) || answer.length > 0)) {
            trail.push({ stage: 'local', by: name, outcome: 'resolved', ms: Date.now() - started });
            const outcome: Outcome = Array.isArray(answer) ? { kind: 'call', calls: answer } : answer;
            return withHeard(fromOutcome(outcome, 'local', trail));
          }
          trail.push({ stage: 'local', by: name, outcome: 'noMatch', why: 'noMatch', ms: Date.now() - started });
        }
      }
      // A confirmation is answered by the user, never by an AI.
      if (pending?.value.kind === 'confirm') return withHeard({ kind: 'unresolved', reason: 'notUnderstood', trail });
      return withHeard(await stageThree(event.id, live, options, trail, signal));
    } finally {
      port.forget(event.id);
    }
  }

  async function stageThree(id: number, live: boolean, options: { mode?: Mode; ai?: boolean }, trail: Step[], signal: AbortSignal): Promise<Result> {
    if (!ai) return { kind: 'unresolved', reason: 'notUnderstood', trail };
    if (options.ai === false) {
      trail.push({ stage: 'ai', by: 'shama', outcome: 'skipped', why: 'aiNotAllowed', ms: 0 });
      return { kind: 'unresolved', reason: 'aiNotAllowed', trail };
    }
    const limits = { ...DEFAULT_LIMITS, ...ai.limits };
    const aiOptions = { brief: ai.brief, live, maxCalls: limits.maxCalls };
    const check = { live, maxCalls: limits.maxCalls, replyChars: limits.replyChars };
    let reason: Unresolved = 'notUnderstood';
    const skip = (by: string, why: Why, because: Unresolved) => {
      trail.push({ stage: 'ai', by, outcome: 'skipped', why, ms: 0 });
      if (reason === 'notUnderstood') reason = because;
    };
    for (const kind of ai.order ?? ['device', 'external']) {
      if (signal.aborted) break;
      const started = Date.now();
      if (kind === 'device') {
        if (!ai.device) continue;
        if (!(await port.deviceAiAvailable(language))) {
          skip('device', 'unavailable', 'notUnderstood');
          continue;
        }
        emit('state', { state: 'deciding', stage: 'ai' });
        try {
          const reply = await within(port.deviceAi(id, { ...aiOptions, timeoutMs: limits.timeoutMs }), limits.timeoutMs, signal);
          const checked = await port.checkReply(reply, check);
          trail.push({ stage: 'ai', by: 'device', outcome: 'resolved', ms: Date.now() - started });
          return fromChecked(checked, trail);
        } catch (error) {
          trail.push({ stage: 'ai', by: 'device', outcome: 'failed', why: whyOf(error), ms: Date.now() - started });
          reason = 'aiFailed';
        }
      } else {
        const provider = ai.external;
        if (!provider) continue;
        if ((options.mode ?? mode) !== 'online') {
          skip(provider.name, 'offline', 'offline');
          continue;
        }
        if (live && !ai.live) {
          skip(provider.name, 'aiNotAllowed', 'aiNotAllowed');
          continue;
        }
        if (!(await port.online()) || !(await provider.available(language))) {
          skip(provider.name, 'offline', 'offline');
          continue;
        }
        emit('state', { state: 'deciding', stage: 'ai' });
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort);
        try {
          const request = await port.aiRequest(id, aiOptions);
          if (!request) {
            skip(provider.name, 'unavailable', 'notUnderstood');
            continue;
          }
          const reply = await within(provider.decide(request, controller.signal), limits.timeoutMs, signal, controller);
          const checked = await port.checkReply(reply, check);
          trail.push({ stage: 'ai', by: provider.name, outcome: 'resolved', ms: Date.now() - started });
          return fromChecked(checked, trail);
        } catch (error) {
          trail.push({ stage: 'ai', by: provider.name, outcome: 'failed', why: whyOf(error), ms: Date.now() - started });
          reason = 'aiFailed';
        } finally {
          signal.removeEventListener('abort', abort);
        }
      }
    }
    return { kind: 'unresolved', reason, trail };
  }

  async function listeningStart(): Promise<void> {
    const handlers = [...(listeners.get('listeningStart') ?? [])] as ShamaEvents['listeningStart'][];
    if (handlers.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, LISTENING_START_MS);
    });
    await Promise.race([Promise.all(handlers.map(async (handler) => handler())), waited]);
    clearTimeout(timer);
  }

  // --- Push-to-talk ---

  function finishTurn(current: TurnSession, result: Result): void {
    if (current.finished) return;
    current.finished = true;
    if (session === current) session = null;
    emit('result', result);
    emit('state', { state: 'idle' });
    current.resolve(result);
    void port.stop().catch(() => {});
  }

  function onTurnEvent(current: TurnSession, event: PortEvent): void {
    switch (event.event) {
      case 'recognizing':
        emit('state', { state: 'recognizing' });
        break;
      case 'settled': {
        current.deciding = true;
        const controller = (current.abort = new AbortController());
        decide(event, false, current.options, controller.signal)
          .then((result) => finishTurn(current, result))
          .catch((error) => {
            emit('error', new ShamaError('failed', String(error)));
            finishTurn(current, { kind: 'unresolved', reason: 'failed', trail: event.settled.trail });
          });
        break;
      }
      case 'nothingHeard':
        if (!current.deciding) finishTurn(current, { kind: 'unresolved', reason: 'nothingHeard', trail: [] });
        break;
      case 'done':
        if (!current.deciding) finishTurn(current, { kind: 'unresolved', reason: 'nothingHeard', trail: [] });
        break;
      case 'failed':
        emit('error', new ShamaError('failed', event.message));
        if (!current.deciding) finishTurn(current, { kind: 'unresolved', reason: 'failed', trail: [] });
        break;
      case 'interrupted':
        emit('error', new ShamaError('interrupted', event.reason));
        current.abort?.abort();
        finishTurn(current, { kind: 'cancelled', trail: [] });
        break;
      default:
        break;
    }
  }

  // --- LIVE ---

  function setLiveState(next: LiveState, reason?: LiveEnd): void {
    if (next === liveState && !reason) return;
    liveState = next;
    emit('live', reason ? { state: next, reason } : { state: next });
  }

  function armQuiet(current: LiveSession): void {
    if (current.quiet) clearTimeout(current.quiet);
    current.quiet = undefined;
    const quietMs = current.options.quietMs ?? 120_000;
    if (quietMs > 0 && !speakingNow()) {
      current.quiet = setTimeout(() => void endLive('quiet'), quietMs);
    }
  }

  /** Shama's state as the voices change: listening, or – while one speaks – interrupt words or a pause. */
  function applyVoices(): void {
    const current = session;
    if (current?.kind !== 'live') return;
    if (speakingNow()) {
      if (current.interrupting) {
        sync();
        setLiveState(ownVoice && !appVoice ? 'speaking' : 'interruptOnly');
      } else {
        port.hold(true);
        setLiveState(ownVoice && !appVoice ? 'speaking' : 'paused');
      }
    } else {
      port.hold(false);
      sync();
      setLiveState('listening');
    }
    armQuiet(current);
  }

  async function onLiveSettled(current: LiveSession, event: SettledEvent): Promise<void> {
    const controller = (current.abort = new AbortController());
    const result = await decide(event, true, current.options, controller.signal);
    if (session !== current) return;
    // While the app speaks, what isn't an interrupt goes by unremarked.
    if (result.kind === 'unresolved' && result.reason === 'interruptOnly') return;
    emit('result', result);
    if (result.kind === 'stopListening') {
      await endLive('command');
      return;
    }
    const text = current.options.speak ? current.options.speak(result) : defaultSpeech(result);
    if (text) await live.say(text);
  }

  function onLiveEvent(current: LiveSession, event: PortEvent): void {
    switch (event.event) {
      case 'speech':
        armQuiet(current);
        break;
      case 'settled':
        current.queue = current.queue
          .then(() => onLiveSettled(current, event))
          .catch((error) => emit('error', new ShamaError('failed', String(error))));
        break;
      case 'echoCancellation':
        if (!event.available && current.interrupting) {
          // No echo cancellation here: pause while the app speaks instead.
          current.interrupting = false;
          applyVoices();
        }
        break;
      case 'failed':
        emit('error', new ShamaError('failed', event.message));
        break;
      case 'interrupted':
        emit('error', new ShamaError('interrupted', event.reason));
        void endLive('interrupted');
        break;
      case 'done':
        void endLive('failed');
        break;
      default:
        break;
    }
  }

  async function endLive(reason: LiveEnd): Promise<void> {
    const current = session;
    if (current?.kind !== 'live') return;
    session = null;
    if (current.quiet) clearTimeout(current.quiet);
    current.abort?.abort();
    ownVoice = false;
    port.stopSpeaking();
    sync();
    setLiveState('off', reason);
    await port.stop().catch(() => {});
  }

  const live: Live = {
    async start(options) {
      if (session) throw new ShamaError('busy', 'Shama is already listening');
      language = options.language;
      const current: LiveSession = {
        kind: 'live',
        options,
        interrupting: (options.whileAppSpeaks ?? 'interrupt') === 'interrupt',
        queue: Promise.resolve(),
      };
      session = current;
      sync();
      try {
        await port.listen(listenOptions(options, 'continuous', { ...LIVE_ENDPOINTING, ...options.endpointing }, false, current.interrupting));
      } catch (error) {
        session = null;
        throw asShamaError(error);
      }
      applyVoices();
    },
    stop: () => endLive('toggle'),
    appSpeaking(speaking) {
      appVoice = speaking;
      applyVoices();
    },
    async say(text) {
      ownVoice = true;
      applyVoices();
      try {
        await port.speak(text, language);
      } finally {
        ownVoice = false;
        applyVoices();
      }
    },
    get state() {
      return liveState;
    },
  };

  function listenOptions(
    options: StartOptions | LiveOptions,
    listenMode: ListenOptions['mode'],
    endpointing: Endpointing | undefined,
    partial: boolean,
    echoCancellation: boolean,
  ): ListenOptions {
    return {
      mode: listenMode,
      language: options.language,
      recognizer: options.recognizer,
      endpointing,
      partial,
      echoCancellation,
      transcripts: options.transcripts,
      file: options.file,
    };
  }

  port.subscribe((event) => {
    if (event.event === 'level') {
      emit('level', event.level);
      return;
    }
    const current = session;
    if (!current) return;
    if (current.kind === 'turn') onTurnEvent(current, event);
    else onLiveEvent(current, event);
  });

  return {
    async setVocabulary(next) {
      const problems = await port.setVocabulary(next);
      if (problems.length > 0) {
        throw new ShamaError('vocabulary', problems.map((p) => `${p.path}: ${p.message}`).join('\n'), problems);
      }
      vocabulary = next;
      setPending(null);
    },
    setContext(context) {
      if (context.contexts && context.contexts.join('\n') !== contexts.join('\n')) {
        contexts = [...context.contexts];
        setPending(null);
      }
      if (context.state) state = { ...context.state };
      sync();
    },
    setMode(next) {
      mode = next;
    },
    setAi(settings) {
      ai = settings;
    },
    addResolver(resolver, options = {}) {
      const entry = { resolver, name: options.name ?? `resolver ${resolvers.length + 1}`, contexts: options.contexts };
      resolvers.push(entry);
      return () => {
        const index = resolvers.indexOf(entry);
        if (index >= 0) resolvers.splice(index, 1);
      };
    },
    requestPermission: () => port.requestPermission(),
    async start(options) {
      if (session) throw new ShamaError('busy', 'Shama is already listening');
      language = options.language;
      sync();
      await listeningStart();
      return new Promise<Result>((resolve, reject) => {
        const current: TurnSession = { kind: 'turn', options, resolve, deciding: false, finished: false };
        session = current;
        emit('state', { state: 'listening' });
        const listenMode = options.until === 'release' ? 'hold' : 'tap';
        port.listen(listenOptions(options, listenMode, options.endpointing, true, false)).catch((error) => {
          if (session === current) session = null;
          emit('state', { state: 'idle' });
          reject(asShamaError(error));
        });
      });
    },
    async stop() {
      if (session?.kind === 'turn') await port.release();
      else if (session?.kind === 'live') await endLive('toggle');
    },
    async cancel() {
      const current = session;
      if (current?.kind === 'turn') {
        current.abort?.abort();
        finishTurn(current, { kind: 'cancelled', trail: [] });
      } else if (current?.kind === 'live') {
        await endLive('toggle');
      }
    },
    async confirm(yes) {
      if (pending?.value.kind !== 'confirm') return null;
      const { value, stage } = pending;
      const result = yes ? fromOutcome({ kind: 'call', calls: value.calls }, stage, []) : fromOutcome({ kind: 'cancelled' }, stage, []);
      emit('result', result);
      return result;
    },
    async choose(index) {
      if (pending?.value.kind !== 'choose') return null;
      const { value, stage } = pending;
      const call = value.candidates[index];
      if (!call) return null;
      const result = fromOutcome(await port.finish(call), stage, []);
      emit('result', result);
      return result;
    },
    reset() {
      setPending(null);
    },
    get pending() {
      return pending?.value ?? null;
    },
    live,
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const added = listener as Listener;
      set.add(added);
      return () => {
        set.delete(added);
      };
    },
  };
}

/** What Shama says by itself in LIVE: its questions, and what an AI answered. */
function defaultSpeech(result: Result): string | null {
  if (result.kind === 'ask') return result.question ?? null;
  if (result.kind === 'reply') return result.reply;
  if (result.kind === 'call' && result.reply) return result.reply;
  return null;
}

function whyOf(error: unknown): Why {
  if (error instanceof AiError) return error.why;
  if (typeof error === 'string') return error as Why;
  if (error && typeof error === 'object' && 'why' in error) return (error as { why: Why }).why;
  return 'invalidReply';
}

function asShamaError(error: unknown): ShamaError {
  if (error instanceof ShamaError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = (error && typeof error === 'object' && 'code' in error ? (error as { code: string }).code : 'failed') as ErrorCode;
  return new ShamaError(['busy', 'permission', 'vocabulary', 'failed', 'interrupted'].includes(code) ? code : 'failed', message);
}

/** A promise, given up after `ms` or when `signal` aborts. */
function within<T>(promise: Promise<T>, ms: number, signal: AbortSignal, controller?: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller?.abort();
      reject(new AiError('timeout', 'the AI took too long'));
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new AiError('timeout', 'cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
