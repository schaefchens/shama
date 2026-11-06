// The vocabulary without a microphone: a text settled as if it had been heard, and the tools and
// phrases the language has.

import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import type { Result } from '@schaefchens/shama';
import { useShama } from '@schaefchens/shama-react';
import { rtl, vocabulary } from '../../shared/demo';
import type { DemoSettings } from '../../shared/demo';
import { ResultCard } from './Listen';
import { Chip, Section, T, usePalette } from './ui';

export function TryText({ settings, onError }: { settings: DemoSettings; onError: (message: string) => void }) {
  const shama = useShama();
  const palette = usePalette();
  const [text, setText] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const { language } = settings;
  const settle = () =>
    void shama
      .start({ language, text, mode: settings.mode, transcripts: true })
      .then(setResult)
      .catch((e: Error) => onError(e.message));
  return (
    <View style={styles.screen}>
      <Section title={`Say it as text (${language})`}>
        <TextInput
          testID="text"
          value={text}
          onChangeText={setText}
          onSubmitEditing={settle}
          placeholder="read Moby Dick chapter three"
          placeholderTextColor={palette.muted}
          style={[styles.input, { color: palette.text, borderColor: palette.border, textAlign: rtl(language) ? 'right' : 'left' }]}
          autoCapitalize="none"
        />
        <Chip label="Settle" onPress={settle} />
      </Section>
      {result && <ResultCard result={result} />}
      <Section title="Vocabulary">
        {vocabulary.tools.map((tool) => {
          const flags = [tool.confirm && 'confirm', tool.ai === false && 'no AI', tool.interrupt && 'interrupt', tool.contexts && `in ${tool.contexts.join(', ')}`].filter(Boolean);
          const phrases = (tool.phrases ?? []).flatMap((phrase) => phrase.say[language] ?? []);
          return (
            <View key={tool.id} style={styles.tool}>
              <T>
                {tool.id}
                {Object.keys(tool.args ?? {}).length ? `(${Object.keys(tool.args ?? {}).join(', ')})` : ''}
                {flags.length ? `  · ${flags.join(' · ')}` : ''}
              </T>
              {phrases.map((phrase, i) => (
                <T key={i} mono small style={{ textAlign: rtl(language) ? 'right' : 'left' }}>
                  {phrase}
                </T>
              ))}
            </View>
          );
        })}
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { gap: 12 },
  input: { borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 16 },
  tool: { gap: 2, paddingVertical: 4 },
});
