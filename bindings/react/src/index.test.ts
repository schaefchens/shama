import { act, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createShama } from '@schaefchens/shama';
import { FakePort } from '@schaefchens/shama/fake';
import { ShamaProvider, useDiagnostics, useListening, useLive, usePushToTalk, useShamaContext } from './index.ts';

function setup() {
  const port = new FakePort();
  const shama = createShama(port);
  const wrapper = ({ children }: { children?: ReactNode }) => createElement(ShamaProvider, { shama, children });
  return { port, shama, wrapper };
}

const settleDown = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('hooks', () => {
  it('push-to-talk shows what Shama does and what came of it', async () => {
    const { port, wrapper } = setup();
    const { result } = renderHook(() => ({ talk: usePushToTalk({ language: 'en' }), listening: useListening() }), { wrapper });
    let pending: Promise<unknown> | undefined;
    await act(async () => {
      pending = result.current.talk.press();
      await settleDown();
    });
    expect(result.current.listening.state).toBe('listening');
    await act(async () => {
      port.emit({ event: 'level', level: 0.5 });
      port.settle({ outcome: { kind: 'call', calls: [{ tool: 'stop' }] }, stage: 'deterministic', trail: [] });
      await pending;
    });
    expect(result.current.listening.state).toBe('idle');
    expect(result.current.listening.result?.kind).toBe('call');
  });

  it('LIVE toggles and follows the app speaking', async () => {
    const { port, wrapper } = setup();
    const { result } = renderHook(() => useLive({ language: 'de', quietMs: 0 }), { wrapper });
    await act(() => result.current.toggle());
    expect(result.current.state).toBe('listening');
    act(() => result.current.appSpeaking(true));
    expect(result.current.state).toBe('interruptOnly');
    expect(port.turn?.appSpeaking).toBe(true);
    await act(() => result.current.toggle());
    expect(result.current.state).toBe('off');
  });

  it("the screen mounted last is in front, and leaves with its contexts", () => {
    const { port, wrapper } = setup();
    const library = renderHook(() => useShamaContext(['library']), { wrapper });
    const reader = renderHook(() => useShamaContext(['reading'], { book: 'moby' }), { wrapper });
    expect(port.turn?.contexts).toEqual(['reading', 'library']);
    expect(port.turn?.state).toEqual({ book: 'moby' });
    reader.unmount();
    expect(port.turn?.contexts).toEqual(['library']);
    library.unmount();
    expect(port.turn?.contexts).toEqual([]);
  });

  it('diagnostics gather the microphone, the meter, utterances and a log', async () => {
    const { port, shama, wrapper } = setup();
    shama.setDebug({ diagnostics: true, keepAudio: true });
    const { result } = renderHook(() => ({ talk: usePushToTalk({ language: 'en' }), diagnostics: useDiagnostics({ historyMs: 120 }) }), { wrapper });
    let pending: Promise<unknown> | undefined;
    await act(async () => {
      pending = result.current.talk.press();
      await settleDown();
    });
    const meter = { level: 0.5, rmsDb: -30, peakDb: -0.1, clipped: true, floorDb: -58, thresholdDb: -38, phase: 'speaking' } as const;
    await act(async () => {
      port.emit({ event: 'input', input: { device: 'Mic', kind: 'builtIn', rate: 48000, channels: 1, processing: 'measurement', echoCancellation: false } });
      for (let i = 0; i < 3; i++) port.emit({ event: 'meter', ...meter, rmsDb: -30 - i });
      port.emit({ event: 'utterance', id: 7, startMs: 100, endMs: 1500, speechMs: 900, cut: 'pause', kept: true });
      port.emit({ event: 'settled', id: 7, recognizer: 'os', speechMs: 900, recognizeMs: 310, settled: { outcome: { kind: 'call', calls: [{ tool: 'stop' }] }, stage: 'deterministic', trail: [] } });
      await pending;
    });
    const { diagnostics } = result.current;
    expect(diagnostics.input?.device).toBe('Mic');
    expect(diagnostics.history.map((m) => m.rmsDb)).toEqual([-31, -32]);
    // Listening over: the last meter stays, done.
    expect(diagnostics.meter).toMatchObject({ rmsDb: -32, phase: 'done' });
    expect(diagnostics.utterances[0]).toMatchObject({ id: 7, cut: 'pause', recognizer: 'os', recognizeMs: 310, result: { kind: 'call' } });
    const lines = diagnostics.log.map((entry) => entry.text);
    expect(lines).toContain('input: Mic (builtIn) · 48 kHz → 16 kHz · 1 ch · measurement');
    expect(lines).toContain('clipping: peak -0.1 dBFS');
    expect(lines).toContain('utterance #7: 1.40 s, 0.90 s of speech, ended by pause, audio kept');
    expect(lines).toContain('#7 heard by os in 310 ms');
    expect(lines).toContain('result: stop() · deterministic');
    act(() => result.current.diagnostics.clear());
    expect(result.current.diagnostics.log).toEqual([]);
  });
});
