// Fetches the first utterances of FLEURS' test split for one language – real voices reading
// Wikipedia sentences (CC BY 4.0) – without downloading the whole archive: the tar.gz is read as
// it streams and the download stops once enough files are in.
//
//   node tools/corpus/fleurs.mjs --lang de [--count 100]
//
// Output: shama/.cache/corpus/<lang>/fleurs/<file>.wav and shama/.cache/corpus/<lang>/fleurs.jsonl.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const lang = args.lang;
const count = Number(args.count ?? 100);
const CODES = { en: 'en_us', de: 'de_de', tr: 'tr_tr', ar: 'ar_eg', fa: 'fa_ir' };
const code = CODES[lang];
if (!code) throw new Error('--lang en|de|tr|ar|fa');
const base = `https://huggingface.co/datasets/google/fleurs/resolve/main/data/${code}`;
const out = path.join(root, '.cache', 'corpus', lang, 'fleurs');
fs.mkdirSync(out, { recursive: true });

const tsv = await (await fetch(`${base}/test.tsv`)).text();
const transcripts = new Map(
  tsv.trim().split('\n').map((line) => line.split('\t')).map((columns) => [columns[1], columns[2]]),
);

const controller = new AbortController();
const response = await fetch(`${base}/audio/test.tar.gz`, { signal: controller.signal });
const source = Readable.fromWeb(response.body);
const stream = source.pipe(zlib.createGunzip());
// Stopping the download early makes both streams fail; that is expected.
source.on('error', () => {});
stream.on('error', () => {});

const files = [];
let buffer = Buffer.alloc(0);
let longName = null;
try {
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 512) {
      const header = buffer.subarray(0, 512);
      if (header.every((byte) => byte === 0)) {
        buffer = buffer.subarray(512);
        continue;
      }
      const size = parseInt(header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim() || '0', 8);
      const padded = Math.ceil(size / 512) * 512;
      if (buffer.length < 512 + padded) break;
      const type = String.fromCharCode(header[156]);
      const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
      const name = longName ?? (prefix ? `${prefix}/` : '') + header.toString('utf8', 0, 100).replace(/\0.*$/, '');
      const data = buffer.subarray(512, 512 + size);
      buffer = buffer.subarray(512 + padded);
      if (type === 'L') {
        longName = data.toString('utf8').replace(/\0.*$/, '');
        continue;
      }
      longName = null;
      const base = path.basename(name);
      if (type !== '0' && type !== '\0') continue;
      if (!base.endsWith('.wav') || !transcripts.has(base)) continue;
      fs.writeFileSync(path.join(out, base), data);
      files.push(base);
      if (files.length >= count) throw new Error('enough');
    }
  }
} catch (error) {
  if (error.message !== 'enough') throw error;
  controller.abort();
}

const manifestPath = path.join(root, '.cache', 'corpus', lang, 'fleurs.jsonl');
const known = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : '';
const lines = [];
for (const base of files) {
  const id = `${lang}-fleurs-${base.replace(/\.wav$/, '')}`;
  if (known.includes(`"${id}"`)) continue;
  const file = path.join(out, base);
  // FLEURS is 16 kHz already; rewrite as plain 16-bit mono so every tool reads it alike.
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', `${file}.tmp.wav`]);
  fs.renameSync(`${file}.tmp.wav`, file);
  const text = transcripts.get(base);
  const ms = Math.round(((fs.statSync(file).size - 44) / 2 / 16000) * 1000);
  lines.push(JSON.stringify({ id, lang, kind: 'fleurs', text, expected: text, voice: 'fleurs', file: path.relative(root, file), ms }));
}
fs.appendFileSync(manifestPath, lines.map((line) => `${line}\n`).join(''));
console.log(`${lang}: ${files.length} FLEURS utterances, ${lines.length} new`);
