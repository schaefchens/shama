// The microphone as Shama hears it: the meter over the last seconds against the room's floor and
// the threshold of speech, and where the audio comes from.

import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { InputInfo, Meter } from '@schaefchens/shama';
import { describeInput } from '@schaefchens/shama-react';
import { db, FLOOR_DB, height, phaseColor } from '../../shared/demo';
import { Section, T, usePalette } from './ui';

/** About 10 s of meters, one every 60 ms. */
const SLOTS = 167;

export function MeterPanel({ meter, history }: { meter: Meter | null; history: Meter[] }) {
  const palette = usePalette();
  const color = { speech: palette.speech, room: palette.room, settling: palette.settling };
  const shown = history.slice(-SLOTS);
  const line = (value: number, tint: string) => (
    <View style={[styles.line, { bottom: `${height(value) * 100}%`, backgroundColor: tint }]} />
  );
  return (
    <Section
      title="Meter"
      right={meter?.clipped ? <T style={{ color: palette.danger, fontWeight: '600' }}>CLIPPING</T> : <T muted small>{meter ? meter.phase : 'not listening'}</T>}
    >
      <View testID="meter-graph" style={[styles.graph, { borderColor: palette.border }]}>
        {shown.map((m, i) => (
          <View key={i} style={[styles.slot, { left: `${(i / SLOTS) * 100}%`, width: `${100 / SLOTS}%` }]}>
            <View style={[styles.bar, { height: `${height(m.peakDb) * 100}%`, backgroundColor: color[phaseColor(m)], opacity: 0.3 }]} />
            <View style={[styles.bar, { height: `${height(m.rmsDb) * 100}%`, backgroundColor: color[phaseColor(m)] }]} />
          </View>
        ))}
        {meter && line(meter.thresholdDb, palette.threshold)}
        {meter && line(meter.floorDb, palette.floor)}
        <T muted small style={[styles.scale, { top: 2 }]}>0</T>
        <T muted small style={[styles.scale, { bottom: 2 }]}>{FLOOR_DB}</T>
      </View>
      {meter ? (
        <View style={styles.numbers}>
          <Number label="loudness" value={db(meter.rmsDb)} />
          <Number label="peak" value={db(meter.peakDb)} />
          <Number label="floor" value={db(meter.floorDb)} tint={palette.floor} />
          <Number label="speech from" value={db(meter.thresholdDb)} tint={palette.threshold} />
        </View>
      ) : (
        <T muted small>The meter shows while Shama listens, with diagnostics on.</T>
      )}
    </Section>
  );
}

function Number({ label, value, tint }: { label: string; value: string; tint?: string }) {
  return (
    <View style={styles.number}>
      <T mono style={tint ? { color: tint } : undefined}>
        {value}
      </T>
      <T muted small>
        {label}
      </T>
    </View>
  );
}

export function InputPanel({ input }: { input: InputInfo | null }) {
  const [more, setMore] = useState(false);
  return (
    <Section
      title="Input"
      right={
        input?.details ? (
          <Pressable onPress={() => setMore(!more)}>
            <T muted small>{more ? 'less' : 'more'}</T>
          </Pressable>
        ) : null
      }
    >
      {input ? (
        <>
          <T testID="input-device">{describeInput(input)}</T>
          {more &&
            Object.entries(input.details ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => (
              <T key={key} mono small>
                {key}: {String(value)}
              </T>
            ))}
        </>
      ) : (
        <T muted small>Where the audio comes from shows once Shama listens, with diagnostics on.</T>
      )}
    </Section>
  );
}

const styles = StyleSheet.create({
  graph: { height: 110, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, overflow: 'hidden' },
  slot: { position: 'absolute', top: 0, bottom: 0, justifyContent: 'flex-end' },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  line: { position: 'absolute', left: 0, right: 0, height: 1 },
  scale: { position: 'absolute', right: 4 },
  numbers: { flexDirection: 'row', justifyContent: 'space-between' },
  number: { alignItems: 'flex-start' },
});
