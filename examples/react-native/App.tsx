import { Asset } from 'expo-asset';
import * as Speech from 'expo-speech';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { fakeProvider, selfTest } from '@schaefchens/shama';
import type { Language, Mode, Result, SelfTestCase, Vocabulary } from '@schaefchens/shama';
import { ShamaProvider, useListening, useLive, usePushToTalk, useShama, useShamaContext } from '@schaefchens/shama-react';
import { createNativeShama } from '@schaefchens/shama-react-native';
import cases from '../../tests/fixtures/audio.json';
import vocabularyJson from '../../tests/fixtures/vocabulary.json';
import { fixtures } from './src/fixtures';

const vocabulary = vocabularyJson as Vocabulary;
const languages: Language[] = ['en', 'de', 'tr', 'ar', 'fa'];

/** What the read-aloud stand-in reads, per language. */
const passage: Record<Language, string> = {
  en: 'Call me Ishmael. Some years ago, never mind how long precisely, having little or no money in my purse, I thought I would sail about a little and see the watery part of the world.',
  de: 'Nennt mich Ismael. Vor einigen Jahren, gleichgültig wann, hatte ich wenig oder gar kein Geld im Beutel und dachte, ich wollte ein wenig herumsegeln.',
  tr: 'Bana İsmail deyin. Birkaç yıl önce, cebimde çok az para varken, biraz denize açılıp dünyanın sulak kısmını görmek istedim.',
  ar: 'نادني إسماعيل. قبل بضع سنوات، وكان في جيبي قليل من المال، فكرت أن أبحر قليلا وأرى الجزء المائي من العالم.',
  fa: 'مرا اسماعیل صدا کنید. چند سال پیش، با جیبی تقریبا خالی، خواستم کمی دریانوردی کنم و بخش آبی جهان را ببینم.',
};

export default function App() {
  const shama = useMemo(() => createNativeShama(), []);
  const [selfTesting, setSelfTesting] = useState(false);
  useEffect(() => {
    const open = (url?: string | null) => url?.includes('self-test') && setSelfTesting(true);
    void Linking.getInitialURL().then(open);
    const subscription = Linking.addEventListener('url', ({ url }) => open(url));
    return () => subscription.remove();
  }, []);
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen}>
        <ShamaProvider shama={shama}>{selfTesting ? <SelfTest /> : <Demo onSelfTest={() => setSelfTesting(true)} />}</ShamaProvider>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Demo({ onSelfTest }: { onSelfTest: () => void }) {
  const shama = useShama();
  const [language, setLanguage] = useState<Language>('en');
  const [mode, setMode] = useState<Mode>('offline');
  const [context, setContext] = useState<'reading' | 'library'>('reading');
  const [pausing, setPausing] = useState(false);
  const [transcripts, setTranscripts] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const listening = useListening();
  const talk = usePushToTalk({ language, until: 'release', mode, transcripts });
  const live = useLive({ language, whileAppSpeaks: pausing ? 'pause' : 'interrupt', mode, transcripts });
  useShamaContext([context]);
  const readingRef = useRef(false);

  useEffect(() => {
    shama.setVocabulary(vocabulary).catch((e: Error) => setError(e.message));
    shama.setAi({
      brief: 'An audiobook reader: it opens books at chapters, moves between chapters, reads faster or slower.',
      device: true,
      external: fakeProvider((request) =>
        request.message.includes('whale') ? { calls: [{ tool: 'open', args: { book: 'moby' } }] } : { calls: [], reply: 'I open books and move between chapters.' },
      ),
    });
    const stops = [
      shama.on('error', (e) => setError(e.message)),
      // Push-to-talk: the app's voice pauses before the microphone opens.
      shama.on('listeningStart', () => stopReading()),
    ];
    return () => stops.forEach((stop) => stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shama]);

  useEffect(() => shama.setMode(mode), [shama, mode]);

  function startReading() {
    readingRef.current = true;
    setReading(true);
    live.appSpeaking(true);
    const ended = () => {
      readingRef.current = false;
      setReading(false);
      live.appSpeaking(false);
    };
    Speech.speak(passage[language], { language, onDone: ended, onStopped: ended, onError: ended });
  }

  function stopReading() {
    if (readingRef.current) void Speech.stop();
  }

  // What the demo app does with its tools: it shows them.
  useEffect(() => {
    const result = listening.result;
    if (result?.kind === 'call' && result.calls.some((c) => c.tool === 'stop' || c.tool === 'pause')) stopReading();
  }, [listening.result]);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>Shama</Text>
      <Text style={styles.hint}>Try “read Moby Dick chapter three”, “next chapter”, “faster”, “where am I”, “stop”.</Text>
      <Row label="Language">
        {languages.map((l) => (
          <Chip key={l} label={l} selected={language === l} onPress={() => setLanguage(l)} />
        ))}
      </Row>
      <Row label="Mode">
        {(['offline', 'online'] as Mode[]).map((m) => (
          <Chip key={m} label={m} selected={mode === m} onPress={() => setMode(m)} />
        ))}
      </Row>
      <Row label="Screen">
        {(['reading', 'library'] as const).map((c) => (
          <Chip key={c} label={c} selected={context === c} onPress={() => setContext(c)} />
        ))}
      </Row>
      <Row label="Pause while the app reads">
        <Switch value={pausing} onValueChange={setPausing} disabled={live.state !== 'off'} />
      </Row>
      <Row label="Show what was heard">
        <Switch value={transcripts} onValueChange={setTranscripts} />
      </Row>
      <View style={styles.actions}>
        <Pressable
          testID="talk"
          style={[styles.talk, listening.state !== 'idle' && styles.talking]}
          disabled={live.state !== 'off'}
          onPressIn={() => void talk.press()}
          onPressOut={() => void talk.release()}
        >
          <Text style={styles.talkText}>{listening.state === 'idle' ? 'Hold to talk' : listening.state}</Text>
        </Pressable>
        <Chip label={`LIVE: ${live.state}`} selected={live.state !== 'off'} onPress={() => void live.toggle().catch((e: Error) => setError(e.message))} />
        <Chip label={reading ? 'Stop reading' : 'Read aloud'} selected={reading} onPress={() => (reading ? stopReading() : startReading())} />
      </View>
      <View style={[styles.level, { width: `${Math.round(listening.level * 100)}%` }]} />
      {error && (
        <Text style={styles.error} onPress={() => setError(null)}>
          {error}
        </Text>
      )}
      {listening.pending?.kind === 'confirm' && (
        <Row label="Sure?">
          <Chip label="Yes" onPress={() => void shama.confirm(true)} />
          <Chip label="No" onPress={() => void shama.confirm(false)} />
        </Row>
      )}
      {listening.pending?.kind === 'choose' && (
        <Row label="Which one?">
          {listening.pending.candidates.map((call, i) => (
            <Chip key={i} label={describeCall(call)} onPress={() => void shama.choose(i)} />
          ))}
        </Row>
      )}
      {listening.result && <ResultCard result={listening.result} />}
      <Chip label="Self-test" onPress={onSelfTest} />
    </ScrollView>
  );
}

/** The fixture recordings through this device's native module and core. */
function SelfTest() {
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
        report: (line) => current && setLines((all) => [...all, line]),
      });
      if (current) setResult(`${report.failed === 0 ? 'passed' : 'failed'}: ${report.passed} of ${report.passed + report.failed}`);
    })().catch((error: Error) => current && setResult(`failed: ${error.message}`));
    return () => {
      current = false;
    };
  }, [shama]);
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>Self-test</Text>
      <Text testID="self-test-result" style={styles.result}>
        {result}
      </Text>
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </ScrollView>
  );
}

function describeCall(call: { tool: string; args?: Record<string, unknown> }): string {
  const args = Object.entries(call.args ?? {})
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ');
  return args ? `${call.tool}(${args})` : call.tool;
}

function ResultCard({ result }: { result: Result }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>
        {result.kind}
        {'stage' in result ? ` · ${result.stage}` : ''}
        {result.kind === 'unresolved' ? ` · ${result.reason}` : ''}
      </Text>
      {result.kind === 'call' && <Text>{result.calls.map(describeCall).join('; ')}</Text>}
      {result.kind === 'ask' && <Text>{result.question ?? `missing ${result.missing}`}</Text>}
      {result.kind === 'reply' && <Text>“{result.reply}”</Text>}
      {result.heard && <Text style={styles.hint}>heard: {result.heard.map((h) => h.text).join(' | ')}</Text>}
      {result.trail.map((step, i) => (
        <Text key={i} style={styles.trail}>
          {step.stage} · {step.by} · {step.outcome}
          {step.why ? ` (${step.why})` : ''}
        </Text>
      ))}
    </View>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.chips}>{children}</View>
    </View>
  );
}

function Chip({ label, selected, onPress }: { label: string; selected?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, selected && styles.selected]}>
      <Text>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16, gap: 12 },
  title: { fontSize: 24, fontWeight: '600' },
  hint: { opacity: 0.7 },
  row: { gap: 6 },
  label: { fontWeight: '500' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  chip: { borderWidth: 1, borderColor: '#999', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  selected: { backgroundColor: '#cde' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  talk: { backgroundColor: '#246', borderRadius: 28, paddingHorizontal: 24, paddingVertical: 16 },
  talking: { backgroundColor: '#a33' },
  talkText: { color: 'white', fontSize: 16 },
  level: { height: 4, backgroundColor: '#3a6' },
  error: { color: '#b3261e' },
  card: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, gap: 4 },
  cardTitle: { fontWeight: '600' },
  trail: { fontSize: 12, opacity: 0.8 },
  result: { fontSize: 18 },
});
