// Talking to Shama, and what it made of it: hold to talk or LIVE, an app voice to interrupt, the
// self-test's recordings as if heard, the meter and the microphone, the result and its stages, and
// the last utterances – played back, saved, heard again.

import { Asset } from 'expo-asset';
import * as Speech from 'expo-speech';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, Share, StyleSheet, View } from 'react-native';
import type { LanguageSupport, Result, SavedRecording } from '@schaefchens/shama';
import { describeCall, describeResult, useListening, useLive, usePushToTalk, useShama } from '@schaefchens/shama-react';
import type { Diagnostics, UtteranceInfo } from '@schaefchens/shama-react';
import { hints, languages, liveDefaults, modelFor, passage, seconds } from '../../shared/demo';
import type { DemoSettings } from '../../shared/demo';
import { fixtures } from './fixtures';
import { InputPanel, MeterPanel } from './Microphone';
import { Chip, Row, Section, T, usePalette } from './ui';

interface Props {
  settings: DemoSettings;
  update: (change: Partial<DemoSettings>) => void;
  diagnostics: Diagnostics;
  support: LanguageSupport[];
  onError: (message: string) => void;
}

export function Listen({ settings, update, diagnostics, support, onError }: Props) {
  const shama = useShama();
  const palette = usePalette();
  const listening = useListening();
  const { language, mode, recognizer, transcripts, endpointing } = settings;
  const talk = usePushToTalk({ language, until: settings.until, mode, recognizer, transcripts, endpointing });
  const live = useLive({ language, whileAppSpeaks: settings.whileAppSpeaks, mode, recognizer, transcripts, endpointing: { ...liveDefaults, ...endpointing } });
  const [reading, setReading] = useState(false);
  const readingRef = useRef(false);

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

  // Push-to-talk: the app's voice pauses before the microphone opens.
  useEffect(() => shama.on('listeningStart', () => stopReading()), [shama]);

  // What the demo does with its tools: it stops reading when told to, and shows the rest.
  useEffect(() => {
    const result = listening.result;
    if (result?.kind === 'call' && result.calls.some((c) => c.tool === 'stop' || c.tool === 'pause')) stopReading();
  }, [listening.result]);

  /** A self-test recording through the pipeline: its own transcripts heard, or the recognizer chosen. */
  async function hearRecording(name: string) {
    const asset = await Asset.fromModule(fixtures[name]).downloadAsync();
    await shama.start({
      language,
      file: asset.localUri ?? asset.uri,
      until: 'pause',
      recognizer: recognizer === 'auto' ? undefined : recognizer,
      mode,
      transcripts,
      endpointing,
    });
  }

  const recordings = Object.keys(fixtures).filter((name) => name.startsWith(`${language}-`));
  const busy = listening.state !== 'idle';
  return (
    <View style={styles.screen}>
      <Row label="Language">
        {languages.map((l) => (
          <Chip key={l} label={l} selected={language === l} onPress={() => update({ language: l })} />
        ))}
      </Row>
      <Row label="Recognizer">
        {(['auto', 'os', 'embedded'] as const).map((r) => (
          <Chip key={r} label={r === 'auto' ? `auto (${support.find((s) => s.language === language)?.recognizer ?? '…'})` : r} selected={recognizer === r} onPress={() => update({ recognizer: r })} />
        ))}
      </Row>
      {support.find((s) => s.language === language)?.recognizer === 'none' && (
        <T small style={{ color: palette.threshold }} testID="no-recognizer">
          Nothing here hears {language}: the system has no recognizer for it on the device, and there is no embedded model. Put one in
          the app's shama-models/{language} – `node tools/models.mjs &lt;folder&gt; {modelFor[language]}` – or try a recording below.
        </T>
      )}
      <T muted small>
        Try {hints[language]}.
      </T>
      <View style={styles.actions}>
        <Pressable
          testID="talk"
          style={[styles.talk, { backgroundColor: busy ? palette.danger : palette.accent }]}
          disabled={live.state !== 'off'}
          onPressIn={() => void talk.press().catch((e: Error) => onError(e.message))}
          onPressOut={() => settings.until === 'release' && void talk.release()}
        >
          <T style={styles.talkText}>{listening.state === 'idle' ? (settings.until === 'release' ? 'Hold to talk' : 'Tap to talk') : listening.state}</T>
        </Pressable>
        <Chip testID="live" label={`LIVE: ${live.state}`} selected={live.state !== 'off'} onPress={() => void live.toggle().catch((e: Error) => onError(e.message))} />
        <Chip label={reading ? 'Stop reading' : 'Read aloud'} selected={reading} onPress={() => (reading ? stopReading() : startReading())} />
      </View>
      <Row label="Hear a recording (auto: its own transcript)">
        {recordings.map((name) => (
          <Chip
            key={name}
            testID={`recording-${name.replace('.wav', '')}`}
            label={name.replace('.wav', '')}
            disabled={busy || live.state !== 'off'}
            onPress={() => void hearRecording(name).catch((e: Error) => onError(e.message))}
          />
        ))}
      </Row>
      <MeterPanel meter={diagnostics.meter} history={diagnostics.history} />
      <InputPanel input={diagnostics.input} />
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
      <Utterances settings={settings} utterances={diagnostics.utterances} support={support} onError={onError} />
    </View>
  );
}

export function ResultCard({ result }: { result: Result }) {
  return (
    <Section title={`Result: ${result.kind}`}>
      <T testID="result">{describeResult(result)}</T>
      {result.heard && <T muted>heard: {result.heard.map((h) => `“${h.text}”${h.confidence !== undefined ? ` ${h.confidence.toFixed(2)}` : ''}`).join(' | ')}</T>}
      {result.trail.map((step, i) => (
        <T key={i} mono small>
          {step.stage} · {step.by} · {step.outcome}
          {step.why ? ` (${step.why})` : ''} · {step.ms} ms
        </T>
      ))}
    </Section>
  );
}

function Utterances({ settings, utterances, support, onError }: { settings: DemoSettings; utterances: UtteranceInfo[]; support: LanguageSupport[]; onError: (message: string) => void }) {
  const shama = useShama();
  const [playing, setPlaying] = useState<number | null>(null);
  const [saved, setSaved] = useState<Record<number, SavedRecording>>({});

  async function save(id: number): Promise<SavedRecording> {
    const recording = saved[id] ?? (await shama.recordings.save(id));
    setSaved((all) => ({ ...all, [id]: recording }));
    return recording;
  }

  async function play(id: number) {
    if (playing === id) {
      shama.recordings.stop();
      return;
    }
    setPlaying(id);
    try {
      await shama.recordings.play(id);
    } finally {
      setPlaying((now) => (now === id ? null : now));
    }
  }

  /** The saved WAV through the pipeline again – with the recognizer chosen now, `auto` as it picks. */
  async function again(id: number) {
    const { uri } = await save(id);
    const chosen = settings.recognizer === 'auto' ? support.find((s) => s.language === settings.language)?.recognizer : settings.recognizer;
    await shama.start({
      language: settings.language,
      file: uri,
      recognizer: chosen === 'os' || chosen === 'embedded' ? chosen : undefined,
      transcripts: settings.transcripts,
      mode: settings.mode,
    });
  }

  const run = (work: () => Promise<unknown>) => () => void work().catch((e: Error) => onError(e.message));
  return (
    <Section title="Utterances" right={<T muted small>{settings.keepAudio ? 'audio kept in memory' : 'audio not kept'}</T>}>
      {utterances.length === 0 && <T muted small>Each utterance Shama cuts from the audio shows here, newest first.</T>}
      {utterances.map((u) => (
        <View key={u.id} testID={`utterance-${u.id}`} style={styles.utterance}>
          <T>
            #{u.id} · {seconds(u.endMs - u.startMs)} ({seconds(u.speechMs)} speech) · ended by {u.cut}
          </T>
          <T muted small>
            {u.recognizer ? `${u.recognizer}${u.recognizeMs !== undefined ? ` · ${u.recognizeMs} ms` : ''}` : u.failed ? `failed: ${u.failed}` : 'recognizing…'}
            {u.result ? ` · ${describeResult(u.result)}` : ''}
          </T>
          {u.heard && <T muted small>“{u.heard.map((h) => h.text).join(' | ')}”</T>}
          {u.kept && (
            <View style={styles.actions}>
              <Chip testID={`play-${u.id}`} label={playing === u.id ? 'Stop' : 'Play'} selected={playing === u.id} onPress={run(() => play(u.id))} />
              <Chip testID={`save-${u.id}`} label={saved[u.id] ? 'Saved' : 'Save'} onPress={run(() => save(u.id))} />
              <Chip testID={`again-${u.id}`} label="Hear again" onPress={run(() => again(u.id))} />
              {saved[u.id] && Platform.OS === 'ios' && <Chip label="Share" onPress={run(() => Share.share({ url: saved[u.id].uri }))} />}
            </View>
          )}
          {saved[u.id] && (
            <T mono small selectable testID={`saved-${u.id}`}>
              {saved[u.id].uri.replace('file://', '')}
            </T>
          )}
        </View>
      ))}
    </Section>
  );
}

const styles = StyleSheet.create({
  screen: { gap: 12 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  talk: { borderRadius: 26, paddingHorizontal: 22, paddingVertical: 14 },
  talkText: { color: 'white', fontSize: 16, fontWeight: '600' },
  utterance: { gap: 4, paddingVertical: 6 },
});
