// The self-test in Node, through the real core as WASM – what the worker does, in-process (src/node.ts) –
// with the fixture recordings from tools/fixtures.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { selfTest } from '@schaefchens/shama';
import type { SelfTestCase, Vocabulary } from '@schaefchens/shama';
import { createNodeShama } from '../src/node.ts';

const root = new URL('../../../', import.meta.url);
const fixtures = new URL('.cache/fixtures/', root);

test('the self-test passes through the core as WASM', async () => {
  execFileSync('node', [new URL('tools/fixtures.mjs', root).pathname, fixtures.pathname]);
  const shama = createNodeShama();
  const vocabulary = JSON.parse(readFileSync(new URL('tests/fixtures/vocabulary.json', root), 'utf8')) as Vocabulary;
  const cases = JSON.parse(readFileSync(new URL('tests/fixtures/audio.json', root), 'utf8')) as SelfTestCase[];
  const report = await selfTest(shama, { vocabulary, cases, file: (name) => new URL(name, fixtures).pathname });
  assert.equal(report.failed, 0, report.lines.join('\n'));
  // No system recognizer here: the spoken cases are skipped.
  assert.equal(report.skipped, cases.filter((testCase) => testCase.recognizer).length);
  assert.equal(report.passed + report.skipped, cases.length);
});
