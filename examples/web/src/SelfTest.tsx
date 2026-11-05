import { useEffect, useState } from 'react';
import { selfTest } from '@schaefchens/shama';
import type { SelfTestCase, Vocabulary } from '@schaefchens/shama';
import { createWebShama } from '@schaefchens/shama-web';
import cases from '../../../tests/fixtures/audio.json';
import vocabulary from '../../../tests/fixtures/vocabulary.json';

/** `?self-test`: the fixture recordings through this browser's worker and core. */
export function SelfTest() {
  const [lines, setLines] = useState<string[]>([]);
  const [result, setResult] = useState('running');
  useEffect(() => {
    let current = true;
    const shama = createWebShama();
    selfTest(shama, {
      vocabulary: vocabulary as Vocabulary,
      cases: cases as SelfTestCase[],
      file: (name) => `/fixtures/${name}`,
      report: (line) => current && setLines((all) => [...all, line]),
    })
      .then((report) => current && setResult(`${report.failed === 0 ? 'passed' : 'failed'}: ${report.passed} of ${report.passed + report.failed}`))
      .catch((error: Error) => current && setResult(`failed: ${error.message}`));
    return () => {
      current = false;
    };
  }, []);
  return (
    <main>
      <h1>Self-test</h1>
      <p id="self-test-result" data-testid="self-test-result">
        {result}
      </p>
      <ul>
        {lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </main>
  );
}
