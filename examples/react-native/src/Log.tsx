// Everything Shama told, a line each, the newest first: to read, share and clear.

import { Share, StyleSheet, View } from 'react-native';
import type { Diagnostics } from '@schaefchens/shama-react';
import { stamp } from '../../shared/demo';
import { Chip, Section, T } from './ui';

export function Log({ diagnostics }: { diagnostics: Diagnostics }) {
  const lines = diagnostics.log.map((entry) => `${stamp(entry.at)}  ${entry.text}`);
  return (
    <View style={styles.screen}>
      <Section
        title={`Log (${lines.length})`}
        right={
          <View style={styles.actions}>
            <Chip label="Share" onPress={() => void Share.share({ message: lines.join('\n') })} />
            <Chip label="Clear" onPress={diagnostics.clear} />
          </View>
        }
      >
        {lines.length === 0 && <T muted small>Nothing yet: talk, or settle a text.</T>}
        {[...lines].reverse().map((line, i) => (
          <T key={lines.length - i} mono small selectable>
            {line}
          </T>
        ))}
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { gap: 12 },
  actions: { flexDirection: 'row', gap: 8 },
});
