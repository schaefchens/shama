// What both demos share: the audiobook reader's vocabulary and voice, the settings they try Shama
// with, and how they show numbers. The screens are each platform's own.

import { fakeProvider } from '@schaefchens/shama';
import type { AiSettings, Endpointing, Language, Meter, Mode, RecognizerChoice, Vocabulary } from '@schaefchens/shama';
import vocabularyJson from '../../tests/fixtures/vocabulary.json';

export const vocabulary = vocabularyJson as Vocabulary;
export const languages: Language[] = ['en', 'de', 'tr', 'ar', 'fa'];
export const rtl = (language: Language) => language === 'ar' || language === 'fa';

/** What to try saying, per language. */
export const hints: Record<Language, string> = {
  en: '“read Moby Dick chapter three”, “next chapter”, “faster”, “where am I”, “stop”',
  de: '„lies das dritte Kapitel von Faust“, „nächstes Kapitel“, „schneller“, „stopp“',
  tr: '“Moby Dick üçüncü bölüm oku”, “sonraki bölüm”, “daha hızlı”, “dur”',
  ar: '«اقرأ موبي ديك الفصل الثالث»، «الفصل التالي»، «أسرع»، «توقف»',
  fa: '«موبی دیک فصل سه را بخوان»، «فصل بعد»، «تندتر»، «بایست»',
};

/** The embedded model engines/sherpa/models.json has for each language. */
export const modelFor: Record<Language, string> = {
  en: 'en-parakeet',
  de: 'de-fastconformer',
  tr: 'tr-seda',
  ar: 'ar-whisper-small',
  fa: 'fa-rizeh',
};

/** What the read-aloud stand-in reads, per language: the app's own voice, to interrupt. */
export const passage: Record<Language, string> = {
  en: 'Call me Ishmael. Some years ago, never mind how long precisely, having little or no money in my purse, I thought I would sail about a little and see the watery part of the world.',
  de: 'Nennt mich Ismael. Vor einigen Jahren, gleichgültig wann, hatte ich wenig oder gar kein Geld im Beutel und dachte, ich wollte ein wenig herumsegeln.',
  tr: 'Bana İsmail deyin. Birkaç yıl önce, cebimde çok az para varken, biraz denize açılıp dünyanın sulak kısmını görmek istedim.',
  ar: 'نادني إسماعيل. قبل بضع سنوات، وكان في جيبي قليل من المال، فكرت أن أبحر قليلا وأرى الجزء المائي من العالم.',
  fa: 'مرا اسماعیل صدا کنید. چند سال پیش، با جیبی تقریبا خالی، خواستم کمی دریانوردی کنم و بخش آبی جهان را ببینم.',
};

/** Stage 3: the device's model where there is one, and a fake external AI that knows one book. */
export const ai: AiSettings = {
  brief: 'An audiobook reader: it opens books at chapters, moves between chapters, reads faster or slower.',
  device: true,
  external: fakeProvider(
    (request) =>
      request.message.includes('whale') ? { calls: [{ tool: 'open', args: { book: 'moby' } }] } : { calls: [], reply: 'I open books and move between chapters.' },
    { name: 'fake' },
  ),
};

export interface DemoSettings {
  language: Language;
  mode: Mode;
  recognizer: RecognizerChoice;
  /** The screen the reader shows: its tools come first. */
  context: 'reading' | 'library';
  whileAppSpeaks: 'interrupt' | 'pause';
  transcripts: boolean;
  diagnostics: boolean;
  keepAudio: boolean;
  /** Push-to-talk ends when the button is let go, or at a pause. */
  until: 'release' | 'pause';
  endpointing: Endpointing;
}

/** A debugging demo: it shows all it can. */
export const initialSettings: DemoSettings = {
  language: 'en',
  mode: 'offline',
  recognizer: 'auto',
  context: 'reading',
  whileAppSpeaks: 'interrupt',
  transcripts: true,
  diagnostics: true,
  keepAudio: true,
  until: 'release',
  endpointing: {},
};

/** The endpointer's settings to try: Shama's defaults, and how far each goes. */
export const knobs: { key: keyof Endpointing; label: string; defaultMs: number; min: number; max: number; step: number }[] = [
  { key: 'endPauseMs', label: 'End pause', defaultMs: 900, min: 200, max: 3000, step: 100 },
  { key: 'minSpeechMs', label: 'Shortest speech', defaultMs: 120, min: 20, max: 600, step: 20 },
  { key: 'settleMs', label: 'Learning the room', defaultMs: 200, min: 0, max: 2000, step: 100 },
  { key: 'nothingHeardMs', label: 'Give up after', defaultMs: 6000, min: 0, max: 20000, step: 1000 },
  { key: 'maxUtteranceMs', label: 'Longest utterance', defaultMs: 15000, min: 2000, max: 30000, step: 1000 },
  { key: 'preRollMs', label: 'Kept before speech', defaultMs: 300, min: 0, max: 1000, step: 50 },
  { key: 'postRollMs', label: 'Kept after speech', defaultMs: 400, min: 0, max: 1000, step: 50 },
];

/** LIVE's own defaults differ: a shorter end pause, and no giving up. */
export const liveDefaults: Partial<Endpointing> = { endPauseMs: 700, nothingHeardMs: 0 };

/** The meter's scale: -70 dBFS at the bottom, full scale at the top. */
export const FLOOR_DB = -70;

/** A level in dBFS as a fraction of the meter's height. */
export function height(db: number): number {
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
}

export const db = (value: number) => `${value <= -119 ? '−∞' : value.toFixed(1)} dB`;

/** The color of a moment of the meter: speech, the room, or the endpointer still learning it. */
export function phaseColor(meter: Meter): 'speech' | 'room' | 'settling' {
  if (meter.phase === 'speaking') return 'speech';
  if (meter.phase === 'settling') return 'settling';
  return 'room';
}

/** Milliseconds since the diagnostics began, as m:ss.mmm. */
export function stamp(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(3).padStart(6, '0');
  return `${minutes}:${seconds}`;
}

export const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
