// A port without a microphone or a core, driven by hand: for tests – Shama's and apps' – of what
// the pipeline does with what the device settled.

import { AiError } from './ai.ts';
import type { ListenOptions, LanguageSupport, Port, PortEvent } from './port.ts';
import type { AiReply, AiRequest, Call, Checked, Hypothesis, Outcome, Problem, Settled, Turn, Vocabulary } from './types.ts';

export interface FakePortOptions {
  /** The device's language model: whether there is one, and what it answers. */
  deviceAi?: { available?: boolean; reply?: (id: number) => AiReply | Promise<AiReply> };
  online?: boolean;
  /** The tools the fake check lets an AI call. */
  tools?: string[];
  /** What setVocabulary reports. */
  problems?: Problem[];
}

export class FakePort implements Port {
  readonly options: FakePortOptions;
  /** What the pipeline asked of the port, in order. */
  readonly log: string[] = [];
  readonly turns: Turn[] = [];
  readonly listened: ListenOptions[] = [];
  readonly spoken: string[] = [];
  private readonly listeners = new Set<(event: PortEvent) => void>();
  private readonly kept = new Map<number, Hypothesis[]>();
  private nextId = 1;

  constructor(options: FakePortOptions = {}) {
    this.options = options;
  }

  /** The last turn the pipeline set. */
  get turn(): Turn | undefined {
    return this.turns[this.turns.length - 1];
  }

  emit(event: PortEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  /** An utterance the device settled – or didn't – and what was heard in it. */
  settle(settled: Settled, heard: Hypothesis[] = []): number {
    const id = this.nextId++;
    this.kept.set(id, heard);
    this.emit({ event: 'settled', id, recognizer: 'fake', speechMs: 800, settled });
    return id;
  }

  async configure(): Promise<LanguageSupport[]> {
    return [];
  }

  async setVocabulary(_: Vocabulary): Promise<Problem[]> {
    this.log.push('setVocabulary');
    return this.options.problems ?? [];
  }

  setTurn(turn: Turn): void {
    this.turns.push(turn);
  }

  async listen(options: ListenOptions): Promise<void> {
    this.log.push(`listen:${options.mode}`);
    this.listened.push(options);
  }

  async release(): Promise<void> {
    this.log.push('release');
  }

  hold(paused: boolean): void {
    this.log.push(`hold:${paused}`);
  }

  async stop(): Promise<void> {
    this.log.push('stop');
  }

  async heard(id: number): Promise<Hypothesis[] | null> {
    this.log.push(`heard:${id}`);
    return this.kept.get(id) ?? null;
  }

  forget(id: number): void {
    this.kept.delete(id);
  }

  async finish(call: Call): Promise<Outcome> {
    return { kind: 'call', calls: [call] };
  }

  async aiRequest(id: number, options: { brief: string; live: boolean; maxCalls: number }): Promise<AiRequest | null> {
    this.log.push(`aiRequest:${id}`);
    const heard = this.kept.get(id);
    if (!heard) return null;
    return {
      system: `rules\n\n${options.brief}`,
      message: `<heard>${heard[0]?.text ?? ''}</heard>`,
      tools: (this.options.tools ?? []).map((name) => ({ name, description: name, parameters: { type: 'object' } })),
      maxCalls: options.maxCalls,
    };
  }

  async deviceAiAvailable(): Promise<boolean> {
    return this.options.deviceAi?.available ?? false;
  }

  async deviceAi(id: number): Promise<AiReply> {
    this.log.push(`deviceAi:${id}`);
    return (await this.options.deviceAi?.reply?.(id)) ?? { calls: [] };
  }

  async checkReply(reply: AiReply, options: { live: boolean; maxCalls: number; replyChars: number }): Promise<Checked> {
    this.log.push('checkReply');
    const tools = this.options.tools ?? [];
    if (reply.calls.length > options.maxCalls) throw new AiError('invalidReply', 'too many calls');
    if (reply.calls.length === 1 && reply.calls[0].tool === 'not_addressed' && options.live) return { outcome: { kind: 'ignored' } };
    if (reply.calls.some((call) => !tools.includes(call.tool))) throw new AiError('invalidReply', 'a tool not offered');
    const text = reply.reply?.slice(0, options.replyChars);
    if (reply.calls.length === 0) {
      if (text) return { reply: text };
      throw new AiError('invalidReply', 'nothing');
    }
    const calls = reply.calls.map((call) => ({ tool: call.tool, args: call.args as Call['args'] }));
    return { outcome: { kind: 'call', calls }, reply: text };
  }

  async speak(text: string): Promise<void> {
    this.log.push(`speak:${text}`);
    this.spoken.push(text);
  }

  stopSpeaking(): void {
    this.log.push('stopSpeaking');
  }

  async online(): Promise<boolean> {
    return this.options.online ?? true;
  }

  async requestPermission(): Promise<boolean> {
    return true;
  }

  subscribe(listener: (event: PortEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
