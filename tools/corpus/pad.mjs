// Copies a language's corpus with the silence Shama's endpointer keeps around speech – 300 ms
// before, 400 ms after – into shama/.cache/padded/.cache/corpus/<lang>, for recognizers that
// read files as they are (Apple's, through tools/apple-speech).
//
//   node tools/corpus/pad.mjs --lang de
import fs from 'node:fs';
import path from 'node:path';
import { readWav, writeWav } from './variants.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const lang = process.argv[process.argv.indexOf('--lang') + 1];
const padded = path.join(root, '.cache', 'padded');
const source = path.join(root, '.cache', 'corpus', lang);
const target = path.join(padded, '.cache', 'corpus', lang);
fs.mkdirSync(target, { recursive: true });
fs.mkdirSync(path.join(padded, 'tools', 'corpus', 'commands'), { recursive: true });
fs.copyFileSync(path.join(here, 'commands', `${lang}.json`), path.join(padded, 'tools', 'corpus', 'commands', `${lang}.json`));
let count = 0;
for (const manifest of ['manifest.jsonl', 'fleurs.jsonl', 'noise.jsonl', 'variants.jsonl']) {
  if (!fs.existsSync(path.join(source, manifest))) continue;
  const lines = fs.readFileSync(path.join(source, manifest), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const out = lines.map((entry) => {
    const file = path.join(padded, entry.file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) {
      const samples = readWav(path.join(root, entry.file));
      const withSilence = new Float32Array(4800 + samples.length + 6400);
      withSilence.set(samples, 4800);
      writeWav(file, withSilence);
    }
    count++;
    return JSON.stringify(entry);
  });
  fs.writeFileSync(path.join(target, manifest), `${out.join('\n')}\n`);
}
console.log(`${lang}: ${count} padded files in ${target}`);
