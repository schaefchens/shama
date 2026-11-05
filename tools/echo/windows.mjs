// Cuts the echo sessions into what a recognizer would get: a window around each command played
// into the room (kind "command", the command expected) and windows of the reading alone (kind
// "near", nothing expected – a command heard there is a false trigger). Writes them as a corpus
// under shama/.cache/echo/root, which the bench and the Apple tool read like the main corpus.
//
//   node tools/echo/windows.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const echo = path.join(root, '.cache/echo');
const fake = path.join(echo, 'root');
fs.mkdirSync(path.join(fake, 'tools/bench'), { recursive: true });
fs.mkdirSync(path.join(fake, '.cache'), { recursive: true });
fs.mkdirSync(path.join(fake, 'tools/corpus'), { recursive: true });
const link = (target, at) => fs.existsSync(at) || fs.symlinkSync(target, at);
link(path.join(root, 'tools/bench/models.json'), path.join(fake, 'tools/bench/models.json'));
link(path.join(root, '.cache/models'), path.join(fake, '.cache/models'));
link(path.join(root, 'tools/corpus/commands'), path.join(fake, 'tools/corpus/commands'));

const seconds = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
for (const lang of ['de', 'en']) {
  const schedule = JSON.parse(fs.readFileSync(path.join(echo, `schedule-${lang}.json`), 'utf8'));
  const corpus = path.join(fake, '.cache/corpus', lang);
  fs.mkdirSync(corpus, { recursive: true });
  const lines = [];
  for (const vp of ['off', 'on']) {
    const recording = path.join(echo, `${lang}-vp-${vp}.wav`);
    if (!fs.existsSync(`${recording}.format`)) continue;
    // Voice processing hands the cleaned voice on the first channel; without it the first channel
    // is the microphone.
    const mono = path.join(echo, `${lang}-vp-${vp}-16k.wav`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', recording, '-af', 'pan=mono|c0=c0', '-ar', '16000', '-sample_fmt', 's16', mono]);
    const cut = (from, to, id, kind, expected) => {
      const file = path.join(corpus, `${id}.wav`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(from), '-to', String(to), '-i', mono, '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', file]);
      lines.push(JSON.stringify({ id, lang, kind, text: expected, expected, voice: `vp-${vp}`, file: path.relative(fake, file), ms: Math.round((to - from) * 1000) }));
    };
    schedule.forEach((s, i) => cut(Math.max(0, s.at - 0.4), s.at + seconds(s.file) + 0.8, `${lang}-${vp}-command-${i}`, 'command', s.word));
    // The reading alone: two seconds between the commands.
    for (let t = 0.5; t < 50; t += 8) cut(t, t + 2, `${lang}-${vp}-reading-${t}`, 'near', '');
  }
  fs.writeFileSync(path.join(corpus, 'manifest.jsonl'), `${lines.join('\n')}\n`);
  console.log(`${lang}: ${lines.length} windows`);
}
