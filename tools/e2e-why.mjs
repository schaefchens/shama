// Why the device test failed, as GitHub's annotations – read without a login, unlike a job's log:
// the flows that failed, the step, what the screen showed then, and the app's errors on the device.
//
//   node tools/e2e-why.mjs <the device test's output> [<a Maestro run's folder>] [<host notes>] [<device log>]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [output, given, host, devicelog] = process.argv.slice(2);
const runs = join(homedir(), '.maestro/tests');
const newest = (folder) =>
  existsSync(folder) ? readdirSync(folder).map((name) => join(folder, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] : undefined;
const run = given || newest(runs);

// GitHub takes ten error annotations a step: three for the flows, the rest for each one's why.
const notes = [];
const note = (title, text) => notes.length < 10 && notes.push(`::error title=${title}::${escape(text.trim().slice(0, 600))}`);
const escape = (text) => text.replaceAll('%', '%25').replaceAll('\r', '').replaceAll('\n', '%0A');

const failed = readFileSync(output, 'utf8')
  .split('\n')
  .filter((line) => line.startsWith('[Failed]'));
if (failed.length === 0) note('Device test', 'failed before any flow ran – see the step\'s log');
for (const line of failed.slice(0, 3)) note('Maestro', line);

// The device gone: whether it was still there, the host's memory and its killer, its last words.
const lines = (file) => (file && existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const hostNotes = lines(host);
if (hostNotes.length && !hostNotes[0].endsWith('device')) {
  note('Device', hostNotes.join('\n'));
  note('Device log, last', lines(devicelog).slice(-12).join('\n'));
}

for (const line of failed) {
  const flow = line.match(/^\[Failed\] (\S+)/)?.[1];
  const folder = run && flow ? join(run, flow) : undefined;
  if (!folder || !existsSync(folder)) continue;
  const log = join(folder, 'logs', 'maestro.log');
  const step = existsSync(log) ? readFileSync(log, 'utf8').split('\n').findLast((l) => l.includes('CommandFailed')) : undefined;
  if (step) note(`${flow}: step`, step.replace(/^.*CommandFailed: /, ''));
  // What the screen showed at the last step Maestro saved: the self-test's ✗ lines first.
  const screen = newest(join(folder, 'screen-hierarchy'));
  if (screen) {
    const texts = [];
    const walk = (node) => {
      const text = node.attributes?.text;
      if (text && !texts.includes(text)) texts.push(text);
      (node.children ?? []).forEach(walk);
    };
    walk(JSON.parse(readFileSync(screen, 'utf8')));
    const telling = texts.filter((text) => /✗|failed|error|Error/.test(text));
    note(`${flow}: screen`, (telling.length ? telling : texts).join('\n'));
  }
  const logcat = join(folder, 'logs', 'device-logcat.txt');
  if (existsSync(logcat)) {
    const errors = readFileSync(logcat, 'utf8')
      .split('\n')
      .filter((l) => /FATAL EXCEPTION|AndroidRuntime: |ReactNativeJS.*(Error|error)|shama.*(Exception|error)/.test(l));
    if (errors.length) note(`${flow}: device log`, errors.slice(-6).join('\n'));
  }
}
console.log(notes.join('\n'));
