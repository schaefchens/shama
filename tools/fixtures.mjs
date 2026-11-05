// Writes the self-test's WAV files: voice-like tones where tests/fixtures/audio.json says
// something is said, a quiet room's hiss around them, and what is said in Shama's "shma" chunk,
// which the fixture recognizer reads. Cases for the system's recognizer are spoken instead, by
// macOS's `say` – elsewhere they get tones, and fail where a system recognizer would run them.
//
//   node tools/fixtures.mjs <output folder>
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rate = 48_000;
const cases = JSON.parse(readFileSync(new URL('../tests/fixtures/audio.json', import.meta.url), 'utf8'));
const out = process.argv[2];
if (!out) {
  console.error('usage: node tools/fixtures.mjs <output folder>');
  process.exit(1);
}
mkdirSync(out, { recursive: true });

let seed = 11;
const hiss = () => {
  seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
  return ((seed >>> 9) / (1 << 23) - 0.5) * 0.004;
};
const voice = (i) => {
  const t = i / rate;
  const tone = (hz) => Math.sin(2 * Math.PI * hz * t);
  return 0.05 * tone(140) + 0.03 * tone(280) + 0.02 * tone(560);
};

const voices = { en: 'Samantha', de: 'Anna', tr: 'Yelda', ar: 'Majed' };

/** The text spoken by macOS's voice for the language, as samples at `rate` – or null. */
function spoken(language, text) {
  if (process.platform !== 'darwin' || !voices[language]) return null;
  const folder = mkdtempSync(join(tmpdir(), 'shama-say-'));
  try {
    const file = join(folder, 'said.wav');
    execFileSync('say', ['-v', voices[language], '-o', file, '--file-format=WAVE', `--data-format=LEI16@${rate}`, text]);
    const wav = readFileSync(file);
    const data = wav.indexOf('data', 12);
    const pcm = wav.subarray(data + 8, data + 8 + wav.readUInt32LE(data + 4));
    return Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2) / 32768);
  } catch {
    return null;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

for (const fixture of cases.filter((fixture) => !fixture.text)) {
  const samples = [];
  const transcripts = [];
  const add = (ms, said) => {
    const start = Math.round((samples.length * 1000) / rate);
    const speech = said !== undefined && fixture.recognizer ? spoken(fixture.language, said) : null;
    if (speech) samples.push(...speech);
    else for (let i = 0; i < (ms * rate) / 1000; i++) samples.push(said === undefined ? hiss() : voice(i));
    if (said !== undefined) transcripts.push({ startMs: start, endMs: Math.round((samples.length * 1000) / rate), text: said });
  };
  add(400);
  for (const said of fixture.utterances) {
    add(900, said);
    add(1200);
  }
  if (fixture.utterances.length === 0) add(7000);
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2));
  const chunk = (id, body) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, 'ascii');
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(1, 2);
  format.writeUInt32LE(rate, 4);
  format.writeUInt32LE(rate * 2, 8);
  format.writeUInt16LE(2, 12);
  format.writeUInt16LE(16, 14);
  const body = Buffer.concat([
    Buffer.from('WAVE'),
    chunk('fmt ', format),
    ...(transcripts.length ? [chunk('shma', Buffer.from(JSON.stringify(transcripts)))] : []),
    chunk('data', data),
  ]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  writeFileSync(join(out, `${fixture.name}.wav`), Buffer.concat([riff, body]));
}
console.log(`${cases.length} fixtures in ${out}`);
