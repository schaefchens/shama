// Scores recognizer runs (JSONL lines with id, kind, expected and hypotheses) against the corpus:
// commands heard exactly, by variant; near misses, everyday sentences, FLEURS speech and noise
// that would pass as a command (a whole-utterance match against commands/<lang>.json's
// templates); FLEURS' WER (en, de, tr) or CER (ar, fa).
//
//   node tools/corpus/score.mjs <run.jsonl>... [--json out.json]
//
// A run file's language comes from its name (<lang>[-kinds].jsonl), its recognizer from its folder.
import fs from 'node:fs';
import path from 'node:path';
import { normalize } from './normalize.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--json');
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;

const compact = (lang, text) => normalize(lang, text).join('');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function commandPattern(lang) {
  const spec = JSON.parse(fs.readFileSync(path.join(here, 'commands', `${lang}.json`), 'utf8'));
  const alt = (list) => `(?:${list.map((x) => escape(compact(lang, x))).sort((a, b) => b.length - a.length).join('|')})`;
  const slots = { '{book}': alt(spec.books), '{surah}': alt(spec.surahs), '{c}': '\\d+', '{v}': '\\d+', '{s}': '\\d+', '{a}': '\\d+' };
  const templates = spec.templates.map((template) =>
    template
      .split(/(\{[a-z]+\})/)
      .map((part) => slots[part] ?? escape(compact(lang, part)))
      .join(''),
  );
  const fixed = spec.commands.map((c) => escape(compact(lang, c)));
  return new RegExp(`^(?:${[...templates, ...fixed].join('|')})$`);
}

function edits(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

const results = [];
const fixed = {};
for (const file of files) {
  const lang = path.basename(file).slice(0, 2);
  const recognizer = path.basename(path.dirname(file));
  const pattern = commandPattern(lang);
  // Lines without an id (a custom model's preparation time, a run's error) aren't hearings.
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).flatMap((l) => {
    try {
      const line = JSON.parse(l);
      return line.id ? [line] : [];
    } catch {
      return [];
    }
  });
  if (!lines.length) continue;
  const r = { recognizer, lang, n: lines.length, kinds: {} };
  const kind = (k) => (r.kinds[k] ??= { n: 0, exact: 0, close: 0, accepted: 0, nonEmpty: 0, errors: 0, refLength: 0, ms: 0, decode: [] });
  for (const line of lines) {
    const hypothesis = line.hypotheses?.[0]?.text ?? '';
    const fixedCommands = fixed[lang] ??= new Set(JSON.parse(fs.readFileSync(path.join(here, 'commands', `${lang}.json`), 'utf8')).commands);
    const k = line.kind === 'variant' ? `variant:${line.id.split('-').pop()}` : line.kind === 'command' ? (fixedCommands.has(line.expected) ? 'command:fixed' : 'command:template') : line.kind;
    const s = kind(k);
    s.n += 1;
    s.ms += line.audio_ms ?? 0;
    if (line.decode_ms != null) s.decode.push(line.decode_ms);
    if (line.latency_ms != null) s.decode.push(line.latency_ms);
    const heard = compact(lang, hypothesis);
    if (heard) s.nonEmpty += 1;
    const expected = compact(lang, line.expected);
    if (heard && heard === expected) s.exact += 1;
    // Close: the numbers exactly right, the letters within about one edit in eight – roughly what a
    // tolerant whole-utterance matcher forgives.
    const digits = (t) => (t.match(/\d+/g) ?? []).join(',');
    if (heard && digits(heard) === digits(expected) && edits([...expected], [...heard]) <= Math.max(1, Math.round(expected.length / 8))) s.close += 1;
    if (heard && pattern.test(heard)) s.accepted += 1;
    if (line.kind === 'fleurs') {
      const ref = ['ar', 'fa'].includes(lang) ? [...compact(lang, line.expected)] : normalize(lang, line.expected);
      const hyp = ['ar', 'fa'].includes(lang) ? [...heard] : normalize(lang, hypothesis);
      s.errors += edits(ref, hyp);
      s.refLength += ref.length;
    }
  }
  results.push(r);
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}` : '–');
const q = (list, p) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.round((sorted.length - 1) * p)]) : '–';
};
console.log('| recognizer | lang | commands exact / close % | fixed / names+numbers close % | 10 dB SNR close % | near accepted % | oov accepted % | FLEURS WER/CER % | FLEURS accepted /h | noise non-empty | p50 / p95 ms (commands) |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of results) {
  const parts = [r.kinds['command:fixed'], r.kinds['command:template']].filter(Boolean);
  const c = parts.reduce((a, b) => ({ n: a.n + b.n, exact: a.exact + b.exact, close: a.close + b.close, decode: [...a.decode, ...b.decode] }), { n: 0, exact: 0, close: 0, decode: [] });
  const cf = r.kinds['command:fixed'] ?? { n: 0 };
  const ct = r.kinds['command:template'] ?? { n: 0 };
  const v10 = r.kinds['variant:snr10'] ?? { n: 0 };
  const near = r.kinds.near ?? { n: 0 };
  const oov = r.kinds.oov ?? { n: 0 };
  const fl = r.kinds.fleurs ?? { n: 0, ms: 0 };
  const noise = r.kinds.noise ?? { n: 0 };
  const perHour = fl.ms ? (fl.accepted / (fl.ms / 3_600_000)).toFixed(1) : '–';
  console.log(
    `| ${r.recognizer} | ${r.lang} | ${pct(c.exact, c.n)} / ${pct(c.close, c.n)} | ${pct(cf.close, cf.n)} / ${pct(ct.close, ct.n)} | ${pct(v10.close, v10.n)} | ${pct(near.accepted, near.n)} | ${pct(oov.accepted, oov.n)} | ${pct(fl.errors, fl.refLength)} | ${perHour} | ${noise.nonEmpty ?? '–'}/${noise.n} | ${q(c.decode, 0.5)} / ${q(c.decode, 0.95)} |`,
  );
}
if (jsonOut) {
  for (const r of results) for (const s of Object.values(r.kinds)) delete s.decode;
  fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2));
}
