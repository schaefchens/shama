// Makes the measuring corpus for one language: spoken commands filled from commands/<lang>.json,
// near misses and everyday sentences, as 16 kHz mono WAVs with their expected text.
//
//   node tools/corpus/make.mjs --lang de [--count 300]
//
// en and de speak through macOS voices (say); tr, ar and fa through OpenAI's gpt-4o-mini-tts,
// plus the one macOS voice tr and ar have. OpenAI needs OPENAI_API_KEY in this command's
// environment. Output: shama/.cache/corpus/<lang>/{<id>.wav, manifest.jsonl}; files already
// made are kept, so a run can be repeated.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const lang = args.lang;
const count = Number(args.count ?? 300);
if (!lang) throw new Error('--lang en|de|tr|ar|fa');

const spec = JSON.parse(fs.readFileSync(path.join(here, 'commands', `${lang}.json`), 'utf8'));
const out = path.join(root, '.cache', 'corpus', lang);
fs.mkdirSync(out, { recursive: true });

const MAC_VOICES = {
  en: ['Samantha', 'Daniel', 'Karen', 'Moira', 'Tessa', 'Rishi', 'Eddy (English (US))', 'Flo (English (UK))', 'Reed (English (US))', 'Sandy (English (UK))'],
  de: ['Anna', 'Eddy (German (Germany))', 'Flo (German (Germany))', 'Grandma (German (Germany))', 'Grandpa (German (Germany))', 'Reed (German (Germany))', 'Rocko (German (Germany))', 'Sandy (German (Germany))', 'Shelley (German (Germany))'],
  tr: ['Yelda'],
  ar: ['Majed'],
  fa: [],
};
const OPENAI_VOICES = ['alloy', 'ash', 'coral', 'echo', 'nova', 'onyx', 'sage', 'shimmer'];
const LANGUAGE_NAMES = { tr: 'Turkish', ar: 'Modern Standard Arabic', fa: 'Persian (Farsi, Iranian)' };
const voices = [
  ...MAC_VOICES[lang].map((name) => ({ provider: 'say', name })),
  ...(lang === 'en' || lang === 'de' ? [] : OPENAI_VOICES.map((name) => ({ provider: 'openai', name }))),
];

// A small seeded generator, so the corpus is the same on every run.
let seed = [...lang].reduce((s, c) => s * 31 + c.charCodeAt(0), 7) >>> 0;
const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (list) => list[Math.floor(random() * list.length)];
const TRICKY = [1, 2, 3, 7, 11, 12, 13, 15, 16, 17, 19, 20, 21, 30, 40, 50, 70, 90, 99, 100, 101, 111, 112, 119, 139, 150, 176, 200, 255, 286];
const number = (max) => (random() < 0.4 ? pick(TRICKY.filter((n) => n <= max)) : 1 + Math.floor(random() * max));

function fill(template) {
  return template
    .replaceAll('{book}', () => pick(spec.books))
    .replaceAll('{surah}', () => pick(spec.surahs))
    .replaceAll('{c}', () => String(number(150)))
    .replaceAll('{v}', () => String(number(176)))
    .replaceAll('{s}', () => String(number(114)))
    .replaceAll('{a}', () => String(number(286)));
}

const items = [];
const commandRepeats = 3;
for (const text of spec.commands) for (let i = 0; i < commandRepeats; i++) items.push({ kind: 'command', text });
while (items.length < count) items.push({ kind: 'command', text: fill(pick(spec.templates)) });
for (const text of spec.near) items.push({ kind: 'near', text });
for (const text of spec.oov) items.push({ kind: 'oov', text });

const manifestPath = path.join(out, 'manifest.jsonl');
const done = new Map(
  fs.existsSync(manifestPath)
    ? fs.readFileSync(manifestPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => [JSON.parse(line).id, JSON.parse(line)])
    : [],
);

async function speak(item, voice, file) {
  if (voice.provider === 'say') {
    execFileSync('say', ['-v', voice.name, '--file-format=WAVE', '--data-format=LEI16@16000', '-o', file, item.text]);
    return;
  }
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: voice.name,
      input: item.text,
      instructions: `Speak in ${LANGUAGE_NAMES[lang]}, naturally, like a person giving a short voice command to an app. Read numbers in ${LANGUAGE_NAMES[lang]}.`,
      response_format: 'wav',
    }),
  });
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const raw = `${file}.raw.wav`;
  fs.writeFileSync(raw, Buffer.from(await response.arrayBuffer()));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', file]);
  fs.unlinkSync(raw);
}

// The data chunk's length: macOS writes a padding chunk before it, so the header isn't 44 bytes.
function durationMs(file) {
  const wav = fs.readFileSync(file);
  for (let at = 12; at + 8 <= wav.length; at += 8 + wav.readUInt32LE(at + 4) + (wav.readUInt32LE(at + 4) % 2)) {
    if (wav.toString('ascii', at, at + 4) === 'data') return Math.round((wav.readUInt32LE(at + 4) / 2 / 16000) * 1000);
  }
  throw new Error(`no data chunk in ${file}`);
}

const queue = items.map((item, index) => ({ ...item, id: `${lang}-${String(index).padStart(4, '0')}`, voice: voices[index % voices.length] }));
let next = 0;
const manifest = fs.openSync(manifestPath, 'a');
async function worker() {
  while (next < queue.length) {
    const item = queue[next++];
    if (done.has(item.id)) continue;
    const file = path.join(out, `${item.id}.wav`);
    for (let attempt = 1; ; attempt++) {
      try {
        await speak(item, item.voice, file);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
    const entry = { id: item.id, lang, kind: item.kind, text: item.text, expected: item.text, voice: `${item.voice.provider}:${item.voice.name}`, file: path.relative(root, file), ms: durationMs(file) };
    fs.writeSync(manifest, `${JSON.stringify(entry)}\n`);
  }
}
await Promise.all(Array.from({ length: voices.some((v) => v.provider === 'openai') ? 4 : 1 }, worker));
fs.closeSync(manifest);
console.log(`${lang}: ${queue.length} items in ${out}`);
