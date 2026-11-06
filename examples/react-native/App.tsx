// Shama's demo: an audiobook reader's voice control, with all Shama tells for debugging – the
// microphone, the meter, each utterance kept to play, save and hear again, a log – and its
// self-test.

import { Paths } from 'expo-file-system';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { LanguageSupport } from '@schaefchens/shama';
import { ShamaProvider, useDiagnostics, useListening, useShama, useShamaContext } from '@schaefchens/shama-react';
import { createNativeShama } from '@schaefchens/shama-react-native';
import { ai, initialSettings, languages, vocabulary } from '../shared/demo';
import type { DemoSettings } from '../shared/demo';
import { Listen } from './src/Listen';
import { Log } from './src/Log';
import { SelfTest } from './src/SelfTest';
import { Setup } from './src/Setup';
import { TryText } from './src/TryText';
import { Chip, T, usePalette } from './src/ui';

/** Where tools/e2e_react_native.sh puts embedded models: the app's documents on iOS, its external
 *  files on Android, which adb can write to. */
const modelsFolder =
  Platform.OS === 'ios'
    ? `${Paths.document.uri.replace(/\/$/, '')}/shama-models`
    : 'file:///storage/emulated/0/Android/data/de.schaefchens.shama.example/files/shama-models';

const tabs = ['Listen', 'Setup', 'Text', 'Log', 'Self-test'] as const;
type Tab = (typeof tabs)[number];

export default function App() {
  const shama = useMemo(() => createNativeShama(), []);
  return (
    <SafeAreaProvider>
      <ShamaProvider shama={shama}>
        <Demo />
      </ShamaProvider>
    </SafeAreaProvider>
  );
}

function Demo() {
  const shama = useShama();
  const palette = usePalette();
  const [tab, setTab] = useState<Tab>('Listen');
  const [settings, setSettings] = useState<DemoSettings>(initialSettings);
  const [error, setError] = useState<string | null>(null);
  const [support, setSupport] = useState<LanguageSupport[]>([]);
  // Bumped after a self-test, which sets Shama up its own way.
  const [generation, setGeneration] = useState(0);
  const listening = useListening();
  const diagnostics = useDiagnostics();
  useShamaContext([settings.context]);
  const update = useCallback((change: Partial<DemoSettings>) => setSettings((now) => ({ ...now, ...change })), []);

  useEffect(() => {
    const open = (url?: string | null) => url?.includes('self-test') && setTab('Self-test');
    void Linking.getInitialURL().then(open);
    const subscription = Linking.addEventListener('url', ({ url }) => open(url));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    shama.setVocabulary(vocabulary).catch((e: Error) => setError(e.message));
    shama.setAi(ai);
    if (generation > 0) shama.setContext({ contexts: [settings.context], state: {} });
    return shama.on('error', (e) => setError(`${e.code}: ${e.message}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shama, generation]);
  useEffect(() => shama.setMode(settings.mode), [shama, settings.mode, generation]);
  useEffect(
    () => shama.setDebug({ diagnostics: settings.diagnostics, keepAudio: settings.keepAudio }),
    [shama, settings.diagnostics, settings.keepAudio, generation],
  );
  const refresh = useCallback(() => {
    const models = Object.fromEntries(languages.map((language) => [language, `${modelsFolder}/${language}`]));
    shama.languages({ models }).then(setSupport, (e: Error) => setError(e.message));
  }, [shama]);
  useEffect(refresh, [refresh]);

  const show = (name: Tab) => (tab === name ? undefined : styles.hidden);
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: palette.background }]}>
      <View style={styles.head}>
        <T style={styles.title}>Shama</T>
        <T muted small testID="status">
          {listening.state}
          {listening.stage ? ` (${listening.stage})` : ''} · LIVE {listening.live}
        </T>
      </View>
      <View style={styles.tabs}>
        {tabs.map((name) => (
          <Chip key={name} testID={`tab-${name}`} label={name} selected={tab === name} onPress={() => setTab(name)} />
        ))}
      </View>
      {error && (
        <Pressable onPress={() => setError(null)} style={styles.error}>
          <T style={{ color: palette.danger }} testID="error">
            {error} (tap to dismiss)
          </T>
        </Pressable>
      )}
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={show('Listen')}>
          <Listen settings={settings} update={update} diagnostics={diagnostics} support={support} onError={setError} />
        </View>
        <View style={show('Setup')}>
          <Setup settings={settings} update={update} live={listening.live !== 'off'} support={support} refresh={refresh} modelsFolder={modelsFolder} />
        </View>
        <View style={show('Text')}>
          <TryText settings={settings} onError={setError} />
        </View>
        <View style={show('Log')}>
          <Log diagnostics={diagnostics} />
        </View>
        {tab === 'Self-test' && <SelfTest modelsFolder={modelsFolder} onDone={() => setGeneration((g) => g + 1)} />}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8 },
  title: { fontSize: 24, fontWeight: '600' },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 16, paddingVertical: 8 },
  error: { paddingHorizontal: 16 },
  content: { padding: 16, paddingTop: 4, gap: 12 },
  hidden: { display: 'none' },
});
