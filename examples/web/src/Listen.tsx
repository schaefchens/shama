// Talking to Shama, and what it made of it: hold to talk or LIVE, an app voice to interrupt, the
// meter and the microphone, the result and its stages, and the last utterances – played back,
// saved, heard again. A WAV file can be heard too.

import { useEffect, useRef, useState } from 'react';
import type { Result, SavedRecording } from '@schaefchens/shama';
import { describeCall, describeResult, useListening, useLive, usePushToTalk, useShama } from '@schaefchens/shama-react';
import type { Diagnostics, UtteranceInfo } from '@schaefchens/shama-react';
import { hints, languages, liveDefaults, passage, seconds } from '../../shared/demo';
import type { DemoSettings } from '../../shared/demo';
import { InputPanel, MeterPanel } from './Microphone';
import { Chip, Row, Section } from './ui';

interface Props {
  settings: DemoSettings;
  update: (change: Partial<DemoSettings>) => void;
  diagnostics: Diagnostics;
  onError: (message: string) => void;
}

export function Listen({ settings, update, diagnostics, onError }: Props) {
  const shama = useShama();
  const listening = useListening();
  const { language, mode, recognizer, transcripts, endpointing } = settings;
  const talk = usePushToTalk({ language, until: settings.until, mode, recognizer, transcripts, endpointing });
  const live = useLive({ language, whileAppSpeaks: settings.whileAppSpeaks, mode, recognizer, transcripts, endpointing: { ...liveDefaults, ...endpointing } });
  const [reading, setReading] = useState(false);
  const readingRef = useRef(false);

  function startReading() {
    const synth = globalThis.speechSynthesis;
    const voice = synth?.getVoices().find((v) => v.localService && v.lang.toLowerCase().startsWith(language));
    if (!synth || !voice) {
      onError(`No voice on this device reads ${language}.`);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(passage[language]);
    utterance.voice = voice;
    utterance.onend = utterance.onerror = () => {
      readingRef.current = false;
      setReading(false);
      live.appSpeaking(false);
    };
    readingRef.current = true;
    setReading(true);
    live.appSpeaking(true);
    synth.speak(utterance);
  }

  function stopReading() {
    if (readingRef.current) globalThis.speechSynthesis?.cancel();
  }

  // Push-to-talk: the app's voice pauses before the microphone opens.
  useEffect(() => shama.on('listeningStart', () => stopReading()), [shama]);

  useEffect(() => {
    const result = listening.result;
    if (result?.kind === 'call' && result.calls.some((c) => c.tool === 'stop' || c.tool === 'pause')) stopReading();
  }, [listening.result]);

  /** A WAV of one's own through the pipeline, as if the microphone had heard it. */
  function hearFile(file: File) {
    const url = URL.createObjectURL(file);
    shama
      .start({ language, file: url, mode, transcripts, endpointing })
      .catch((e: Error) => onError(e.message))
      .finally(() => URL.revokeObjectURL(url));
  }

  const busy = listening.state !== 'idle';
  return (
    <div className="row">
      <Row label="Language">
        {languages.map((l) => (
          <Chip key={l} label={l} selected={language === l} onClick={() => update({ language: l })} />
        ))}
      </Row>
      <p className="muted small" dir="auto">
        Try {hints[language]}. This browser has no recognizer yet: utterances are cut, kept and measured, not heard – a WAV with Shama's
        transcripts is.
      </p>
      <div className="actions">
        <button
          type="button"
          className={busy ? 'talk busy' : 'talk'}
          data-testid="talk"
          disabled={live.state !== 'off'}
          onPointerDown={() => void talk.press().catch((e: Error) => onError(e.message))}
          onPointerUp={() => settings.until === 'release' && void talk.release()}
          onPointerLeave={() => settings.until === 'release' && listening.state === 'listening' && void talk.release()}
        >
          {listening.state === 'idle' ? (settings.until === 'release' ? 'Hold to talk' : 'Tap to talk') : listening.state}
        </button>
        <Chip label={`LIVE: ${live.state}`} selected={live.state !== 'off'} onClick={() => void live.toggle().catch((e: Error) => onError(e.message))} />
        <Chip label={reading ? 'Stop reading' : 'Read aloud'} selected={reading} onClick={() => (reading ? stopReading() : startReading())} />
        <label className="small">
          Hear a WAV{' '}
          <input
            type="file"
            accept="audio/wav,.wav"
            data-testid="wav"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) hearFile(file);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      <MeterPanel meter={diagnostics.meter} history={diagnostics.history} />
      <InputPanel input={diagnostics.input} />
      {listening.pending?.kind === 'confirm' && (
        <Row label="Sure?">
          <Chip label="Yes" onClick={() => void shama.confirm(true)} />
          <Chip label="No" onClick={() => void shama.confirm(false)} />
        </Row>
      )}
      {listening.pending?.kind === 'choose' && (
        <Row label="Which one?">
          {listening.pending.candidates.map((call, i) => (
            <Chip key={i} label={describeCall(call)} onClick={() => void shama.choose(i)} />
          ))}
        </Row>
      )}
      {listening.result && <ResultCard result={listening.result} />}
      <Utterances settings={settings} utterances={diagnostics.utterances} onError={onError} />
    </div>
  );
}

export function ResultCard({ result }: { result: Result }) {
  return (
    <Section title={`Result: ${result.kind}`} testId="result">
      <span dir="auto">{describeResult(result)}</span>
      {result.heard && (
        <span className="muted" dir="auto">
          heard: {result.heard.map((h) => `“${h.text}”${h.confidence !== undefined ? ` ${h.confidence.toFixed(2)}` : ''}`).join(' | ')}
        </span>
      )}
      <ol className="mono">
        {result.trail.map((step, i) => (
          <li key={i}>
            {step.stage} · {step.by} · {step.outcome}
            {step.why ? ` (${step.why})` : ''} · {step.ms} ms
          </li>
        ))}
      </ol>
    </Section>
  );
}

function Utterances({ settings, utterances, onError }: { settings: DemoSettings; utterances: UtteranceInfo[]; onError: (message: string) => void }) {
  const shama = useShama();
  const [playing, setPlaying] = useState<number | null>(null);
  const [saved, setSaved] = useState<Record<number, SavedRecording>>({});

  async function save(id: number): Promise<SavedRecording> {
    const recording = saved[id] ?? (await shama.recordings.save(id));
    setSaved((all) => ({ ...all, [id]: recording }));
    return recording;
  }

  async function download(id: number) {
    const { uri, name } = await save(id);
    const link = document.createElement('a');
    link.href = uri;
    link.download = name;
    link.click();
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

  /** The kept audio through the pipeline again, as a file: with the settings chosen now. */
  async function again(id: number) {
    const { uri } = await save(id);
    await shama.start({ language: settings.language, file: uri, transcripts: settings.transcripts, mode: settings.mode, endpointing: settings.endpointing });
  }

  const run = (work: () => Promise<unknown>) => () => void work().catch((e: Error) => onError(e.message));
  return (
    <Section title="Utterances" testId="utterances" right={<span className="muted small">{settings.keepAudio ? 'audio kept in memory' : 'audio not kept'}</span>}>
      {utterances.length === 0 && <span className="muted small">Each utterance Shama cuts from the audio shows here, newest first.</span>}
      {utterances.map((u) => (
        <div key={u.id} className="utterance" data-testid={`utterance-${u.id}`}>
          <span>
            #{u.id} · {seconds(u.endMs - u.startMs)} ({seconds(u.speechMs)} speech) · ended by {u.cut}
          </span>
          <span className="muted small" dir="auto">
            {u.recognizer ? `${u.recognizer}${u.recognizeMs !== undefined ? ` · ${u.recognizeMs} ms` : ''}` : u.failed ? `failed: ${u.failed}` : 'recognizing…'}
            {u.result ? ` · ${describeResult(u.result)}` : ''}
          </span>
          {u.heard && (
            <span className="muted small" dir="auto">
              “{u.heard.map((h) => h.text).join(' | ')}”
            </span>
          )}
          {u.kept && (
            <div className="actions">
              <Chip label={playing === u.id ? 'Stop' : 'Play'} selected={playing === u.id} onClick={run(() => play(u.id))} />
              <Chip label="Save WAV" testId={`save-${u.id}`} onClick={run(() => download(u.id))} />
              <Chip label="Hear again" onClick={run(() => again(u.id))} />
            </div>
          )}
        </div>
      ))}
    </Section>
  );
}
