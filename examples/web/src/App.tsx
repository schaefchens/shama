import { useEffect, useMemo, useRef, useState } from 'react';
import { fakeProvider } from '@schaefchens/shama';
import type { Language, Mode, Result, Vocabulary } from '@schaefchens/shama';
import { ShamaProvider, useListening, useLive, usePushToTalk, useShama, useShamaContext } from '@schaefchens/shama-react';
import { createWebShama } from '@schaefchens/shama-web';
import vocabularyJson from '../../../tests/fixtures/vocabulary.json';

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

export function App() {
  const shama = useMemo(() => createWebShama(), []);
  return (
    <ShamaProvider shama={shama}>
      <Demo />
    </ShamaProvider>
  );
}

function Demo() {
  const shama = useShama();
  const [language, setLanguage] = useState<Language>('en');
  const [mode, setMode] = useState<Mode>('offline');
  const [context, setContext] = useState<'reading' | 'library'>('reading');
  const [whileAppSpeaks, setWhileAppSpeaks] = useState<'interrupt' | 'pause'>('interrupt');
  const [transcripts, setTranscripts] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const listening = useListening();
  const talk = usePushToTalk({ language, until: 'release', mode, transcripts });
  const live = useLive({ language, whileAppSpeaks, mode, transcripts });
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
    const synth = globalThis.speechSynthesis;
    const voice = synth?.getVoices().find((v) => v.localService && v.lang.toLowerCase().startsWith(language));
    if (!synth || !voice) {
      setError(`No voice on this device reads ${language}.`);
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
    if (!readingRef.current) return;
    globalThis.speechSynthesis?.cancel();
  }

  // What the demo app does with its tools: it says so.
  useEffect(() => {
    const result = listening.result;
    if (result?.kind === 'call' && result.calls.some((c) => c.tool === 'stop' || c.tool === 'pause')) stopReading();
  }, [listening.result]);

  return (
    <main dir={language === 'ar' || language === 'fa' ? 'rtl' : 'ltr'}>
      <h1>Shama</h1>
      <p className="hint">An audiobook reader's voice control: try “read Moby Dick chapter three”, “next chapter”, “faster”, “where am I”, “stop”.</p>
      <section className="controls">
        <label>
          Language{' '}
          <select value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
            {languages.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
        <label>
          Mode{' '}
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option>offline</option>
            <option>online</option>
          </select>
        </label>
        <label>
          Screen{' '}
          <select value={context} onChange={(e) => setContext(e.target.value as 'reading' | 'library')}>
            <option>reading</option>
            <option>library</option>
          </select>
        </label>
        <label>
          While the app reads{' '}
          <select value={whileAppSpeaks} onChange={(e) => setWhileAppSpeaks(e.target.value as 'interrupt' | 'pause')} disabled={live.state !== 'off'}>
            <option value="interrupt">listen for interrupts</option>
            <option value="pause">pause</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={transcripts} onChange={(e) => setTranscripts(e.target.checked)} /> Show what was heard
        </label>
      </section>
      <section className="actions">
        <button
          className="talk"
          disabled={live.state !== 'off'}
          onPointerDown={() => void talk.press()}
          onPointerUp={() => void talk.release()}
          onPointerLeave={() => listening.state === 'listening' && void talk.release()}
        >
          {listening.state === 'idle' ? 'Hold to talk' : listening.state}
        </button>
        <button onClick={() => void live.toggle().catch((e: Error) => setError(e.message))}>LIVE: {live.state}</button>
        <button onClick={() => (reading ? stopReading() : startReading())}>{reading ? 'Stop reading' : 'Read aloud'}</button>
        <meter min={0} max={1} value={listening.level} aria-label="Microphone level" />
      </section>
      {error && (
        <p className="error" role="alert">
          {error} <button onClick={() => setError(null)}>×</button>
        </p>
      )}
      {listening.pending?.kind === 'confirm' && (
        <p className="pending">
          Sure? <button onClick={() => void shama.confirm(true)}>Yes</button> <button onClick={() => void shama.confirm(false)}>No</button>
        </p>
      )}
      {listening.pending?.kind === 'choose' && (
        <p className="pending">
          Which one?{' '}
          {listening.pending.candidates.map((call, i) => (
            <button key={i} onClick={() => void shama.choose(i)}>
              {describeCall(call)}
            </button>
          ))}
        </p>
      )}
      {listening.result && <ResultCard result={listening.result} />}
    </main>
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
    <section className="result" aria-live="polite">
      <h2>
        {result.kind}
        {'stage' in result ? ` · ${result.stage}` : ''}
        {result.kind === 'unresolved' ? ` · ${result.reason}` : ''}
      </h2>
      {result.kind === 'call' && <p>{result.calls.map(describeCall).join('; ')}</p>}
      {result.kind === 'ask' && <p>{result.question ?? `missing ${result.missing}`}</p>}
      {(result.kind === 'reply' || (result.kind === 'call' && result.reply)) && <p>“{'reply' in result ? result.reply : ''}”</p>}
      {result.heard && <p className="heard">heard: {result.heard.map((h) => h.text).join(' | ')}</p>}
      <ol className="trail">
        {result.trail.map((step, i) => (
          <li key={i}>
            {step.stage} · {step.by} · {step.outcome}
            {step.why ? ` (${step.why})` : ''} {step.ms ? `${step.ms} ms` : ''}
          </li>
        ))}
      </ol>
    </section>
  );
}
