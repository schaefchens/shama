// The microphone as Shama hears it: the meter over the last seconds against the room's floor and
// the threshold of speech, and where the audio comes from.

import { useEffect, useRef, useState } from 'react';
import type { InputInfo, Meter } from '@schaefchens/shama';
import { describeInput } from '@schaefchens/shama-react';
import { db, height, phaseColor } from '../../shared/demo';
import { Section } from './ui';

/** About 10 s of meters, one every 60 ms. */
const SLOTS = 167;

export function MeterPanel({ meter, history }: { meter: Meter | null; history: Meter[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const ratio = window.devicePixelRatio || 1;
    const width = element.clientWidth * ratio;
    const tall = element.clientHeight * ratio;
    if (element.width !== width || element.height !== tall) {
      element.width = width;
      element.height = tall;
    }
    const css = getComputedStyle(element);
    const color = (name: string) => css.getPropertyValue(`--${name}`).trim();
    const colors = { speech: color('speech'), room: color('room'), settling: color('settling') };
    context.clearRect(0, 0, width, tall);
    const slot = width / SLOTS;
    const shown = history.slice(-SLOTS);
    shown.forEach((m, i) => {
      context.fillStyle = colors[phaseColor(m)];
      context.globalAlpha = 0.3;
      context.fillRect(i * slot, tall * (1 - height(m.peakDb)), Math.max(slot - 0.5, 1), tall * height(m.peakDb));
      context.globalAlpha = 1;
      context.fillRect(i * slot, tall * (1 - height(m.rmsDb)), Math.max(slot - 0.5, 1), tall * height(m.rmsDb));
    });
    const line = (value: number, tint: string) => {
      context.fillStyle = tint;
      context.fillRect(0, Math.round(tall * (1 - height(value))), width, ratio);
    };
    if (meter) {
      line(meter.thresholdDb, color('threshold'));
      line(meter.floorDb, color('floor'));
    }
  }, [meter, history]);
  return (
    <Section
      title="Meter"
      testId="meter"
      right={meter?.clipped ? <span className="clipping">CLIPPING</span> : <span className="muted small">{meter ? meter.phase : 'not listening'}</span>}
    >
      <canvas ref={canvas} className="graph" aria-label="The microphone's loudness over the last ten seconds" />
      {meter ? (
        <div className="numbers mono">
          <div>
            <span>{db(meter.rmsDb)}</span>
            <span className="muted small">loudness</span>
          </div>
          <div>
            <span>{db(meter.peakDb)}</span>
            <span className="muted small">peak</span>
          </div>
          <div>
            <span style={{ color: 'var(--floor)' }}>{db(meter.floorDb)}</span>
            <span className="muted small">floor</span>
          </div>
          <div>
            <span style={{ color: 'var(--threshold)' }}>{db(meter.thresholdDb)}</span>
            <span className="muted small">speech from</span>
          </div>
        </div>
      ) : (
        <span className="muted small">The meter shows while Shama listens, with diagnostics on.</span>
      )}
    </Section>
  );
}

export function InputPanel({ input }: { input: InputInfo | null }) {
  const [more, setMore] = useState(false);
  return (
    <Section
      title="Input"
      right={
        input?.details ? (
          <button type="button" onClick={() => setMore(!more)}>
            {more ? 'less' : 'more'}
          </button>
        ) : null
      }
    >
      {input ? (
        <>
          <span data-testid="input-device">{describeInput(input)}</span>
          {more && (
            <ul className="mono">
              {Object.entries(input.details ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => (
                <li key={key}>
                  {key}: {String(value)}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <span className="muted small">Where the audio comes from shows once Shama listens, with diagnostics on.</span>
      )}
    </Section>
  );
}
