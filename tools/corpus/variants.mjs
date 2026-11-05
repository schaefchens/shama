// Makes harder copies of a language's commands – slower and faster, in pink noise at 20, 10 and
// 5 dB SNR, quiet (-35 dBFS) and loud (-20 dBFS) – and the noise files every language shares
// (noise, hum, clicks, silence), which must give nothing at all.
//
//   node tools/corpus/variants.mjs --lang de [--every 5]
//
// Output: shama/.cache/corpus/<lang>/variants/*.wav with variants.jsonl, and
// shama/.cache/corpus/noise/*.wav with each language's noise.jsonl.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const lang = args.lang;
const every = Number(args.every ?? 5);
const corpus = path.join(root, '.cache', 'corpus');

export function readWav(file) {
  const wav = fs.readFileSync(file);
  for (let at = 12; at + 8 <= wav.length; ) {
    const size = wav.readUInt32LE(at + 4);
    if (wav.toString('ascii', at, at + 4) === 'data') {
      const samples = new Float32Array(size / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = wav.readInt16LE(at + 8 + i * 2) / 32768;
      return samples;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${file}`);
}

export function writeWav(file, samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

let seed = 12345;
const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
// Pink noise by Paul Kellet's filter over white noise.
function pink(length) {
  const out = new Float32Array(length);
  let [b0, b1, b2, b3, b4, b5, b6] = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < length; i++) {
    const white = random();
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
  }
  return out;
}
const rms = (s) => Math.sqrt(s.reduce((sum, x) => sum + x * x, 0) / s.length);
// Speech level over the frames that carry speech, so the silence around a command doesn't count.
function speechRms(samples) {
  const frames = [];
  for (let i = 0; i + 320 <= samples.length; i += 320) frames.push(rms(samples.subarray(i, i + 320)));
  const loud = frames.filter((r) => r > Math.max(...frames) * 0.1);
  return Math.sqrt(loud.reduce((sum, r) => sum + r * r, 0) / loud.length);
}
const scaled = (samples, gain) => samples.map((x) => x * gain);

function noiseFiles() {
  const dir = path.join(corpus, 'noise');
  fs.mkdirSync(dir, { recursive: true });
  const seconds = 10;
  const n = 16000 * seconds;
  const make = {
    'pink-quiet': () => scaled(pink(n), 0.01 / rms(pink(n))),
    'pink-loud': () => scaled(pink(n), 0.05 / rms(pink(n))),
    'white-quiet': () => Float32Array.from({ length: n }, () => random() * 0.02),
    hum: () => Float32Array.from({ length: n }, (_, i) => 0.05 * Math.sin((2 * Math.PI * 50 * i) / 16000) + 0.02 * Math.sin((2 * Math.PI * 100 * i) / 16000)),
    clicks: () => {
      const s = new Float32Array(n);
      for (let at = 8000; at < n; at += 16000 * 0.7) for (let i = 0; i < 40; i++) s[at + i] = (random() > 0 ? 0.6 : -0.6) * Math.exp(-i / 8);
      return s;
    },
    silence: () => new Float32Array(n),
  };
  return Object.entries(make).map(([name, generate]) => {
    const file = path.join(dir, `${name}.wav`);
    if (!fs.existsSync(file)) writeWav(file, generate());
    return { id: `noise-${name}`, kind: 'noise', text: '', expected: '', voice: name, file: path.relative(root, file), ms: seconds * 1000 };
  });
}

if (lang) {
  const out = path.join(corpus, lang, 'variants');
  fs.mkdirSync(out, { recursive: true });
  const commands = fs.readFileSync(path.join(corpus, lang, 'manifest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'command');
  const chosen = commands.filter((_, i) => i % every === 0);
  const lines = [];
  for (const entry of chosen) {
    const source = path.join(root, entry.file);
    const samples = readWav(source);
    const level = speechRms(samples);
    const variants = {
      'slow': null,
      'fast': null,
      'snr20': 20,
      'snr10': 10,
      'snr5': 5,
      'quiet': -35,
      'loud': -20,
    };
    for (const [name, value] of Object.entries(variants)) {
      const file = path.join(out, `${entry.id}-${name}.wav`);
      if (!fs.existsSync(file)) {
        if (name === 'slow' || name === 'fast') {
          execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', source, '-filter:a', `atempo=${name === 'slow' ? 0.9 : 1.15}`, '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', file]);
        } else if (name.startsWith('snr')) {
          const noise = pink(samples.length);
          const gain = level / rms(noise) / 10 ** (value / 20);
          writeWav(file, samples.map((x, i) => x + noise[i] * gain));
        } else {
          writeWav(file, scaled(samples, 10 ** (value / 20) / level));
        }
      }
      lines.push(JSON.stringify({ ...entry, id: `${entry.id}-${name}`, kind: 'variant', variant: name, file: path.relative(root, file) }));
    }
  }
  fs.writeFileSync(path.join(corpus, lang, 'variants.jsonl'), `${lines.join('\n')}\n`);
  const noise = noiseFiles().map((e) => JSON.stringify({ ...e, lang }));
  fs.writeFileSync(path.join(corpus, lang, 'noise.jsonl'), `${noise.join('\n')}\n`);
  console.log(`${lang}: ${lines.length} variants of ${chosen.length} commands, ${noise.length} noise files`);
}
