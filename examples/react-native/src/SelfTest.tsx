// The fixture recordings through this device's native module and core: what the end-to-end
// tests open by the link shama-example://self-test.

import { Asset } from 'expo-asset';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { selfTest } from '@schaefchens/shama';
import type { SelfTestCase } from '@schaefchens/shama';
import { useShama } from '@schaefchens/shama-react';
import cases from '../../../tests/fixtures/audio.json';
import { languages, vocabulary } from '../../shared/demo';
import { fixtures } from './fixtures';
import { Section, T } from './ui';

export function SelfTest({ modelsFolder, onDone }: { modelsFolder: string; onDone: () => void }) {
  const shama = useShama();
  const [lines, setLines] = useState<string[]>([]);
  const [result, setResult] = useState('running');
  useEffect(() => {
    let current = true;
    (async () => {
      const paths: Record<string, string> = {};
      for (const [name, module] of Object.entries(fixtures)) {
        const asset = await Asset.fromModule(module).downloadAsync();
        paths[name] = asset.localUri ?? asset.uri;
      }
      const report = await selfTest(shama, {
        vocabulary,
        cases: cases as SelfTestCase[],
        file: (name) => paths[name],
        models: Object.fromEntries(languages.map((language) => [language, `${modelsFolder}/${language}`])),
        report: (line) => current && setLines((all) => [...all, line]),
      });
      if (current) setResult(`${report.failed === 0 ? 'passed' : 'failed'}: ${report.passed} of ${report.passed + report.failed}`);
    })()
      .catch((error: Error) => current && setResult(`failed: ${error.message}`))
      // The self-test sets Shama up its own way: the demo sets it back.
      .finally(onDone);
    return () => {
      current = false;
    };
  }, [shama]);
  return (
    <View style={styles.screen}>
      <Section title="Self-test">
        <T testID="self-test-result" style={styles.result}>
          {result}
        </T>
        {lines.map((line, i) => (
          <T key={i} small>
            {line}
          </T>
        ))}
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { gap: 12 },
  result: { fontSize: 18 },
});
