// The demo's few building blocks, in light and dark.

import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Switch, Text, useColorScheme, View } from 'react-native';
import type { StyleProp, TextStyle } from 'react-native';

export interface Palette {
  background: string;
  card: string;
  text: string;
  muted: string;
  border: string;
  selected: string;
  accent: string;
  speech: string;
  room: string;
  settling: string;
  threshold: string;
  floor: string;
  danger: string;
}

const light: Palette = {
  background: '#f4f5f7',
  card: '#ffffff',
  text: '#1b1d21',
  muted: '#5f6670',
  border: '#d5d9df',
  selected: '#d7e6f7',
  accent: '#1f5fa8',
  speech: '#2e8b57',
  room: '#9aa3ad',
  settling: '#c9ced4',
  threshold: '#c97a12',
  floor: '#6c7a89',
  danger: '#b3261e',
};

const dark: Palette = {
  background: '#111316',
  card: '#1b1e23',
  text: '#e8eaed',
  muted: '#9aa1aa',
  border: '#343941',
  selected: '#22384f',
  accent: '#7fb0e8',
  speech: '#5cc58a',
  room: '#5d6670',
  settling: '#3d434b',
  threshold: '#e3a344',
  floor: '#8a96a3',
  danger: '#f2867d',
};

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  const palette = usePalette();
  return (
    <View style={[styles.section, { backgroundColor: palette.card, borderColor: palette.border }]}>
      <View style={styles.sectionHead}>
        <Text style={[styles.sectionTitle, { color: palette.text }]}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  const palette = usePalette();
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { color: palette.muted }]}>{label}</Text>
      <View style={styles.chips}>{children}</View>
    </View>
  );
}

export function Chip(props: { label: string; selected?: boolean; disabled?: boolean; onPress: () => void; testID?: string }) {
  const palette = usePalette();
  return (
    <Pressable
      testID={props.testID}
      onPress={props.onPress}
      disabled={props.disabled}
      style={[
        styles.chip,
        { borderColor: palette.border, opacity: props.disabled ? 0.45 : 1 },
        props.selected && { backgroundColor: palette.selected, borderColor: palette.accent },
      ]}
    >
      <Text style={{ color: palette.text }}>{props.label}</Text>
    </Pressable>
  );
}

export function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (value: boolean) => void }) {
  const palette = usePalette();
  return (
    <View style={styles.toggle}>
      <View style={styles.toggleText}>
        <Text style={{ color: palette.text }}>{label}</Text>
        {hint ? <Text style={[styles.small, { color: palette.muted }]}>{hint}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

/** Text in the palette's colors: plain, muted, small or monospaced. */
export function T(props: { children: ReactNode; muted?: boolean; small?: boolean; mono?: boolean; style?: StyleProp<TextStyle>; testID?: string; selectable?: boolean }) {
  const palette = usePalette();
  return (
    <Text
      testID={props.testID}
      selectable={props.selectable}
      style={[{ color: props.muted ? palette.muted : palette.text }, props.small && styles.small, props.mono && styles.mono, props.style]}
    >
      {props.children}
    </Text>
  );
}

export const styles = StyleSheet.create({
  section: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 12, gap: 8 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { fontWeight: '600', fontSize: 15 },
  row: { gap: 6 },
  label: { fontSize: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  chip: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  toggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  toggleText: { flex: 1 },
  small: { fontSize: 12 },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 12 },
});
