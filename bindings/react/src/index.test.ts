import { act, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createShama } from '@schaefchens/shama';
import { FakePort } from '@schaefchens/shama/fake';
import { ShamaProvider, useListening, useLive, usePushToTalk, useShamaContext } from './index.ts';

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
});
