// How Shama is tried: how a turn ends, the screen in front, what it tells for debugging, the
// endpointer's settings, and what each language is heard with on this device.

import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { LanguageSupport } from '@schaefchens/shama';
import { useShama } from '@schaefchens/shama-react';
import { knobs } from '../../shared/demo';
import type { DemoSettings } from '../../shared/demo';
import { Chip, Row, Section, T, Toggle } from './ui';

interface Props {
  settings: DemoSettings;
  update: (change: Partial<DemoSettings>) => void;
  live: boolean;
  support: LanguageSupport[];
  refresh: () => void;
  modelsFolder: string;
}

export function Setup({ settings, update, live, support, refresh, modelsFolder }: Props) {
  const shama = useShama();
  const [permission, setPermission] = useState<string>('not asked here');
  const knob = (key: (typeof knobs)[number]['key'], value: number | undefined) =>
    update({ endpointing: { ...settings.endpointing, [key]: value } });
  return (
    <View style={styles.screen}>
      <Section title="Listening">
        <Row label="Push-to-talk ends">
          <Chip label="when let go" selected={settings.until === 'release'} onPress={() => update({ until: 'release' })} />
          <Chip label="at a pause" selected={settings.until === 'pause'} onPress={() => update({ until: 'pause' })} />
        </Row>
        <Row label="Mode">
          {(['offline', 'online'] as const).map((m) => (
            <Chip key={m} label={m} selected={settings.mode === m} onPress={() => update({ mode: m })} />
          ))}
        </Row>
        <Row label="Screen in front">
          {(['reading', 'library'] as const).map((c) => (
            <Chip key={c} label={c} selected={settings.context === c} onPress={() => update({ context: c })} />
          ))}
        </Row>
        <Row label="While the app reads, in LIVE">
          <Chip label="listen for interrupts" disabled={live} selected={settings.whileAppSpeaks === 'interrupt'} onPress={() => update({ whileAppSpeaks: 'interrupt' })} />
          <Chip label="pause" disabled={live} selected={settings.whileAppSpeaks === 'pause'} onPress={() => update({ whileAppSpeaks: 'pause' })} />
        </Row>
      </Section>
      <Section title="Debugging">
        <Toggle label="Diagnostics" hint="The microphone, the meter in full, each utterance as it is cut" value={settings.diagnostics} onChange={(diagnostics) => update({ diagnostics })} />
        <Toggle label="Keep audio" hint="The last 8 utterances, in memory, to play, save or hear again" value={settings.keepAudio} onChange={(keepAudio) => update({ keepAudio })} />
        <Toggle label="Show what was heard" hint="The recognizer's readings with each result" value={settings.transcripts} onChange={(transcripts) => update({ transcripts })} />
      </Section>
      <Section title="Endpointing" right={<Chip label="Defaults" onPress={() => update({ endpointing: {} })} />}>
        <T muted small>LIVE ends at 700 ms of pause and never gives up, unless set here.</T>
        {knobs.map(({ key, label, defaultMs, min, max, step }) => {
          const value = settings.endpointing[key];
          const shown = value ?? defaultMs;
          return (
            <View key={key} style={styles.knob}>
              <View style={styles.knobText}>
                <T>{label}</T>
                <T muted small>
                  {value === undefined ? 'default' : `default ${defaultMs} ms`}
                </T>
              </View>
              <Chip label="−" disabled={shown <= min} onPress={() => knob(key, Math.max(min, shown - step))} />
              <T mono style={styles.knobValue}>
                {shown} ms
              </T>
              <Chip label="+" disabled={shown >= max} onPress={() => knob(key, Math.min(max, shown + step))} />
            </View>
          );
        })}
      </Section>
      <Section title="Languages here" right={<Chip label="Refresh" onPress={refresh} />}>
        {support.map((s) => (
          <T key={s.language} mono small testID={`support-${s.language}`}>
            {s.language} · auto: {s.recognizer} · system: {s.os} · embedded: {s.embedded} · device AI: {s.deviceAi ? 'yes' : 'no'}
          </T>
        ))}
        <T muted small selectable>
          Embedded models: {modelsFolder}/&lt;language&gt;
        </T>
      </Section>
      <Section title="Permission">
        <View style={styles.knob}>
          <Chip
            label="Ask for the microphone"
            onPress={() => void shama.requestPermission().then((granted) => setPermission(granted ? 'granted' : 'refused'))}
          />
          <T muted>{permission}</T>
        </View>
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { gap: 12 },
  knob: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  knobText: { flex: 1 },
  knobValue: { minWidth: 64, textAlign: 'center' },
});
