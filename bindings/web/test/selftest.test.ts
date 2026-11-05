// The self-test in Node, through the real core as WASM – what the worker does, in-process – with
// the fixture recordings from tools/fixtures.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AiError, createShama, selfTest } from '@schaefchens/shama';
import type { Port, PortEvent, SelfTestCase, Vocabulary } from '@schaefchens/shama';
import init, { Core } from '../src/generated/shama_wasm.js';

const root = new URL('../../../', import.meta.url);
const fixtures = new URL('.cache/fixtures/', root);

function nodePort(core: Core): Port {
  const listeners = new Set<(event: PortEvent) => void>();
  const emit = (json: string) => {
    for (const event of JSON.parse(json) as PortEvent[]) listeners.forEach((listener) => listener(event));
  };
  return {
    configure: async () => [],
    setVocabulary: async (vocabulary) => JSON.parse(core.setVocabulary(JSON.stringify(vocabulary))),
    setTurn: (turn) => core.setTurn(JSON.stringify(turn)),
    async listen(options) {
      if (options.text !== undefined) {
        const events = core.listenText(JSON.stringify(options), options.text);
        setTimeout(() => emit(events), 0);
        return;
      }
      const events = core.listenFile(JSON.stringify(options), readFileSync(options.file as string), undefined, undefined);
      setTimeout(() => emit(events), 0);
    },
    release: async () => emit(core.release()),
    hold: () => {},
    stop: async () => core.stop(),
    heard: async (id) => JSON.parse(core.heard(id) ?? 'null'),
    forget: (id) => core.forget(id),
    finish: async (call) => JSON.parse(core.finishCall(JSON.stringify(call))),
    aiRequest: async (id, options) => JSON.parse(core.aiRequest(id, JSON.stringify(options)) ?? 'null'),
    deviceAiAvailable: async () => false,
    deviceAi: async () => {
      throw new AiError('unavailable', 'none here');
    },
    async checkReply(reply, options) {
      const checked = JSON.parse(core.checkReply(JSON.stringify(reply), JSON.stringify(options)));
      if (checked.why) throw new AiError(checked.why, 'did not hold up');
      return checked;
    },
    speak: async () => {},
    stopSpeaking: () => {},
    online: async () => true,
    requestPermission: async () => true,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

test('the self-test passes through the core as WASM', async () => {
  execFileSync('node', [new URL('tools/fixtures.mjs', root).pathname, fixtures.pathname]);
  await init({ module_or_path: readFileSync(new URL('../src/generated/shama_wasm_bg.wasm', import.meta.url)) });
  const shama = createShama(nodePort(new Core()));
  const vocabulary = JSON.parse(readFileSync(new URL('tests/fixtures/vocabulary.json', root), 'utf8')) as Vocabulary;
  const cases = JSON.parse(readFileSync(new URL('tests/fixtures/audio.json', root), 'utf8')) as SelfTestCase[];
  const report = await selfTest(shama, { vocabulary, cases, file: (name) => new URL(name, fixtures).pathname });
  assert.equal(report.failed, 0, report.lines.join('\n'));
  // No system recognizer here: the spoken cases are skipped.
  assert.equal(report.skipped, cases.filter((testCase) => testCase.recognizer).length);
  assert.equal(report.passed + report.skipped, cases.length);
});
