// Runs one embedded model as WebAssembly in a headless browser – Playwright's Chromium or Brave –
// over the first commands of a language, and records load, decode times and memory.
//
//   node tools/wasm-bench/bench.mjs --browser chromium|brave --model fa-rizeh --lang fa [--count 50]
//
// The browser is driven over the DevTools protocol (Node's own fetch and WebSocket, no packages).
// sherpa-onnx's runtime comes from shama/.cache/wasm/sherpa, models from shama/.cache/models.
// Output: shama/.cache/runs/wasm-<browser>-<model>/<lang>.jsonl, a line in summary-wasm.jsonl.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const BROWSERS = {
  chromium: `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  brave: `${process.env.HOME}/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`,
};
const models = JSON.parse(fs.readFileSync(path.join(root, 'tools/bench/models.json'), 'utf8'));
const spec = { ...models[args.model], language: args.lang };
const count = Number(args.count ?? 50);
const lines = fs.readFileSync(path.join(root, '.cache/corpus', args.lang, 'manifest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const commands = lines.filter((e) => e.kind === 'command');
// Every sixth command, so fixed commands and filled templates both appear.
const items = commands.filter((_, i) => i % 6 === 0).slice(0, count);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.wav': 'audio/wav' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file;
  if (url === '/') file = path.join(here, 'index.html');
  else if (url.startsWith('/sherpa/')) {
    if (url.endsWith('.data')) {
      // The prebuilt bundle's own model package, replaced by a stub (its files go unused).
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(Buffer.alloc(1024));
    }
    file = path.join(root, '.cache/wasm/sherpa', url.slice(8));
  } else if (url.startsWith('/models/')) file = path.join(root, '.cache/models', url.slice(8));
  else file = path.join(root, url.slice(1));
  if (!file.startsWith(root) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const pagePort = server.address().port;

const debugPort = 9340 + Math.floor(Math.random() * 50);
const profile = path.join(root, '.cache/wasm', `profile-${args.browser}`);
const browser = spawn(BROWSERS[args.browser], [
  '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

let version;
for (let i = 0; i < 100 && !version; i++) {
  await new Promise((r) => setTimeout(r, 200));
  version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((r) => r.json()).catch(() => null);
}
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener('open', resolve));
let nextId = 1;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
const loadStarted = Date.now();
await send('Page.navigate', { url: `http://127.0.0.1:${pagePort}/` }, sessionId);
const evaluate = async (expression, timeout = 600000) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout }, sessionId);
  if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails).slice(0, 500));
  return result.value;
};
while (!(await evaluate('typeof window.runtimeReady === "number"'))) await new Promise((r) => setTimeout(r, 100));
const loadMs = Date.now() - loadStarted;
let run;
try {
  run = await evaluate(`bench(${JSON.stringify(spec)}, ${JSON.stringify(items)})`);
} catch (error) {
  browser.kill();
  throw error;
}
const product = (await send('Browser.getVersion')).product;
browser.kill();
server.close();
socket.close();

const name = `wasm-${args.browser}-${args.model}`;
fs.mkdirSync(path.join(root, '.cache/runs', name), { recursive: true });
fs.writeFileSync(path.join(root, '.cache/runs', name, `${args.lang}.jsonl`), `${run.results.map((r) => JSON.stringify(r)).join('\n')}\n`);
const wasm = fs.readFileSync(path.join(root, '.cache/wasm/sherpa/sherpa-onnx-wasm-main-vad-asr.wasm'));
const decodes = run.results.map((r) => r.decode_ms).sort((a, b) => a - b);
const q = (p) => decodes[Math.round((decodes.length - 1) * p)];
const summary = {
  browser: product, model: args.model, lang: args.lang, utterances: run.results.length,
  wasm_mb: +(wasm.length / 1e6).toFixed(1), wasm_gzip_mb: +(zlib.gzipSync(wasm, { level: 9 }).length / 1e6).toFixed(1),
  wasm_brotli_mb: +(zlib.brotliCompressSync(wasm).length / 1e6).toFixed(1),
  page_to_runtime_ms: loadMs, model_mb: +(run.modelBytes / 1e6).toFixed(1), model_fetch_ms: run.fetchMs, recognizer_create_ms: run.createMs,
  decode_p50_ms: Math.round(q(0.5)), decode_p95_ms: Math.round(q(0.95)), wasm_memory_mb: run.wasmMemoryMb,
};
fs.appendFileSync(path.join(root, '.cache/runs/summary-wasm.jsonl'), `${JSON.stringify(summary)}\n`);
console.log(JSON.stringify(summary));
process.exit(0);
