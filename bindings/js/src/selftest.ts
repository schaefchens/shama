// The self-test every platform runs: recordings through the platform's own pipeline – its core,
// its file source, the fixture recognizer reading what each recording says – settled and compared
// with what must come of them. Shown by the examples, run by their end-to-end tests.

import { fakeProvider } from './ai.ts';
import type { Shama } from './shama.ts';
import type { AiReply, Language, Result, Vocabulary } from './types.ts';

export interface SelfTestCase {
  name: string;
  language: Language;
  utterances: string[];
  live?: boolean;
  contexts?: string[];
  /** Said as text, not played from a recording: the test path without audio. */
  text?: boolean;
  /** A fake AI's answer, for a case meant to reach stage 3. */
  ai?: AiReply;
  expect: Partial<Result>[];
}

export interface SelfTestReport {
  passed: number;
  failed: number;
  lines: string[];
}

/** Runs the cases one after another; `file` gives each recording's URL or path. */
export async function selfTest(
  shama: Shama,
  options: { vocabulary: Vocabulary; cases: SelfTestCase[]; file: (name: string) => string; report?: (line: string) => void },
): Promise<SelfTestReport> {
  const report: SelfTestReport = { passed: 0, failed: 0, lines: [] };
  const line = (text: string) => {
    report.lines.push(text);
    options.report?.(text);
  };
  await shama.setVocabulary(options.vocabulary);
  for (const testCase of options.cases) {
    shama.reset();
    shama.setContext({ contexts: testCase.contexts ?? [], state: {} });
    shama.setMode(testCase.ai ? 'online' : 'offline');
    shama.setAi(testCase.ai ? { brief: 'A test.', external: fakeProvider(() => testCase.ai as AiReply, { name: 'fake' }) } : null);
    let results: Result[];
    try {
      results = await run(shama, testCase, options.file(`${testCase.name}.wav`));
    } catch (error) {
      results = [];
      line(`✗ ${testCase.name}: ${error instanceof Error ? error.message : String(error)}`);
      report.failed += 1;
      continue;
    }
    const problem = compare(testCase.expect, results);
    if (problem) {
      report.failed += 1;
      line(`✗ ${testCase.name}: ${problem}`);
    } else {
      report.passed += 1;
      line(`✓ ${testCase.name}`);
    }
  }
  line(`${report.failed === 0 ? 'passed' : 'failed'}: ${report.passed} of ${report.passed + report.failed}`);
  return report;
}

async function run(shama: Shama, testCase: SelfTestCase, file: string): Promise<Result[]> {
  if (testCase.text) return [await shama.start({ language: testCase.language, text: testCase.utterances[0] })];
  if (!testCase.live) return [await shama.start({ language: testCase.language, file })];
  const results: Result[] = [];
  const stopResults = shama.on('result', (result) => results.push(result));
  const ended = new Promise<void>((resolve) => {
    const stop = shama.on('live', ({ state }) => {
      if (state === 'off') {
        stop();
        resolve();
      }
    });
  });
  try {
    await shama.live.start({ language: testCase.language, file, quietMs: 15_000 });
    await ended;
  } finally {
    stopResults();
  }
  return results;
}

/** What differs between what must come and what came, or nothing. */
function compare(expected: Partial<Result>[], results: Result[]): string | null {
  if (expected.length !== results.length) {
    return `${results.length} results, not ${expected.length}: ${results.map(describe).join('; ')}`;
  }
  for (const [i, want] of expected.entries()) {
    const got = results[i] as Record<string, unknown>;
    for (const [key, value] of Object.entries(want)) {
      if (JSON.stringify(sorted(got[key])) !== JSON.stringify(sorted(value))) {
        return `result ${i + 1}: ${key} is ${JSON.stringify(got[key])}, not ${JSON.stringify(value)}`;
      }
    }
  }
  return null;
}

function describe(result: Result): string {
  if (result.kind === 'call') return `call ${result.calls.map((call) => call.tool).join(', ')} (${result.stage})`;
  if (result.kind === 'unresolved') return `unresolved (${result.reason})`;
  return result.kind;
}

/** Objects with their keys in order, so that JSON compares them. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]));
  }
  return value;
}
