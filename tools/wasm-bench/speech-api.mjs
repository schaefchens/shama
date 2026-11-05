// Asks Playwright's Chromium and Brave, headless, which speech and language-model APIs they offer:
// Web Speech recognition, its on-device mode (processLocally), and the built-in Prompt API.
//
//   node tools/wasm-bench/speech-api.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const BROWSERS = {
  chromium: `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  brave: `${process.env.HOME}/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`,
};
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const server = http.createServer((_, res) => res.end('<!doctype html><title>probe</title>'));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const probe = `(async () => {
  // Any of these may never settle in a headless browser: give each five seconds.
  const within = (promise) => Promise.race([promise, new Promise((r) => setTimeout(() => r('no answer in 5 s'), 5000))]);
  const R = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  const ask = async (langs) => { try { return await within(R?.available?.({ langs, processLocally: true })); } catch (e) { return String(e); } };
  let prompt;
  try { prompt = await within(window.LanguageModel?.availability?.()); } catch (e) { prompt = String(e); }
  return {
    SpeechRecognition: typeof window.SpeechRecognition, webkitSpeechRecognition: typeof window.webkitSpeechRecognition,
    availableMethod: typeof R?.available, processLocally: { en: await ask(['en-US']), de: await ask(['de-DE']), tr: await ask(['tr-TR']), ar: await ask(['ar-SA']), fa: await ask(['fa-IR']) },
    LanguageModel: typeof window.LanguageModel, promptAvailability: prompt,
  };
})()`;
for (const [name, executable] of Object.entries(BROWSERS)) {
  const port = 9400 + Math.floor(Math.random() * 50);
  const browser = spawn(executable, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${root}/.cache/wasm/profile-${name}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let version;
  for (let i = 0; i < 100 && !version; i++) {
    await new Promise((r) => setTimeout(r, 200));
    version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null);
  }
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r));
  let id = 0;
  const waiting = new Map();
  socket.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    waiting.get(m.id)?.(m);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve) => { waiting.set(++id, (m) => resolve(m.result)); socket.send(JSON.stringify({ id, method, params, sessionId })); });
  const { targetId } = await send('Target.createTarget', { url: `http://127.0.0.1:${server.address().port}/` });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await new Promise((r) => setTimeout(r, 1000));
  const result = await send('Runtime.evaluate', { expression: probe, awaitPromise: true, returnByValue: true }, sessionId);
  console.log(name, version.Browser, JSON.stringify(result.result.value));
  browser.kill();
  socket.close();
}
server.close();
