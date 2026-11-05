// React hooks for Shama – the same on React Native and the web: what it is doing, push-to-talk,
// LIVE, and the contexts of the screens mounted, the last one in front.

import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ArgValue, LiveOptions, LiveState, Pending, Result, Shama, Stage, StartOptions } from '@schaefchens/shama';

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
