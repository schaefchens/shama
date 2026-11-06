// How Shama is tried: how a turn ends, the screen in front, what it tells for debugging, the
// endpointer's settings, and what each language is heard with in this browser.

import { useState } from 'react';
import type { LanguageSupport } from '@schaefchens/shama';
import { useShama } from '@schaefchens/shama-react';
import { knobs } from '../../shared/demo';
import type { DemoSettings } from '../../shared/demo';
import { Chip, Row, Section, Toggle } from './ui';

interface Props {
  settings: DemoSettings;
  update: (change: Partial<DemoSettings>) => void;
  live: boolean;
  support: LanguageSupport[];
  refresh: () => void;
}

export function Setup({ settings, update, live, support, refresh }: Props) {
  const shama = useShama();
  const [permission, setPermission] = useState('not asked here');
  const knob = (key: (typeof knobs)[number]['key'], value: number) => update({ endpointing: { ...settings.endpointing, [key]: value } });
  return (
    <div className="row">
      <Section title="Listening">
        <Row label="Push-to-talk ends">
          <Chip label="when let go" selected={settings.until === 'release'} onClick={() => update({ until: 'release' })} />
          <Chip label="at a pause" selected={settings.until === 'pause'} onClick={() => update({ until: 'pause' })} />
        </Row>
        <Row label="Mode">
          {(['offline', 'online'] as const).map((m) => (
            <Chip key={m} label={m} selected={settings.mode === m} onClick={() => update({ mode: m })} />
          ))}
        </Row>
        <Row label="Screen in front">
          {(['reading', 'library'] as const).map((c) => (
            <Chip key={c} label={c} selected={settings.context === c} onClick={() => update({ context: c })} />
          ))}
        </Row>
        <Row label="While the app reads, in LIVE">
          <Chip label="listen for interrupts" disabled={live} selected={settings.whileAppSpeaks === 'interrupt'} onClick={() => update({ whileAppSpeaks: 'interrupt' })} />
          <Chip label="pause" disabled={live} selected={settings.whileAppSpeaks === 'pause'} onClick={() => update({ whileAppSpeaks: 'pause' })} />
        </Row>
      </Section>
      <Section title="Debugging">
        <Toggle label="Diagnostics" hint="the microphone, the meter in full, each utterance as it is cut" value={settings.diagnostics} onChange={(diagnostics) => update({ diagnostics })} />
        <Toggle label="Keep audio" hint="the last 8 utterances, in memory, to play, save or hear again" value={settings.keepAudio} onChange={(keepAudio) => update({ keepAudio })} />
        <Toggle label="Show what was heard" hint="the recognizer's readings with each result" value={settings.transcripts} onChange={(transcripts) => update({ transcripts })} />
      </Section>
      <Section title="Endpointing" right={<Chip label="Defaults" onClick={() => update({ endpointing: {} })} />}>
        <span className="muted small">LIVE ends at 700 ms of pause and never gives up, unless set here.</span>
        {knobs.map(({ key, label, defaultMs, min, max, step }) => {
          const value = settings.endpointing[key];
          const shown = value ?? defaultMs;
          return (
            <div key={key} className="knob">
              <span>
                {label} <span className="muted small">{value === undefined ? 'default' : `default ${defaultMs} ms`}</span>
              </span>
              <input type="range" min={min} max={max} step={step} value={shown} aria-label={label} onChange={(e) => knob(key, Number(e.target.value))} />
              <output className="mono">{shown} ms</output>
              <span />
            </div>
          );
        })}
      </Section>
      <Section title="Languages here" right={<Chip label="Refresh" onClick={refresh} />}>
        <ul className="mono">
          {support.map((s) => (
            <li key={s.language}>
              {s.language} · auto: {s.recognizer} · system: {s.os} · embedded: {s.embedded} · device AI: {s.deviceAi ? 'yes' : 'no'}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Permission">
        <div className="actions">
          <Chip label="Ask for the microphone" onClick={() => void shama.requestPermission().then((granted) => setPermission(granted ? 'granted' : 'refused'))} />
          <span className="muted">{permission}</span>
        </div>
      </Section>
    </div>
  );
}
