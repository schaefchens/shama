// The vocabulary without a microphone: a text settled as if it had been heard, and the tools and
// phrases the language has.

import { useState } from 'react';
import type { Result } from '@schaefchens/shama';
import { useShama } from '@schaefchens/shama-react';
import { vocabulary } from '../../shared/demo';
import type { DemoSettings } from '../../shared/demo';
import { ResultCard } from './Listen';
import { Section } from './ui';

export function TryText({ settings, onError }: { settings: DemoSettings; onError: (message: string) => void }) {
  const shama = useShama();
  const [text, setText] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const { language } = settings;
  return (
    <div className="row">
      <Section title={`Say it as text (${language})`}>
        <form
          className="actions"
          onSubmit={(e) => {
            e.preventDefault();
            shama
              .start({ language, text, mode: settings.mode, transcripts: true })
              .then(setResult)
              .catch((error: Error) => onError(error.message));
          }}
        >
          <input type="text" dir="auto" data-testid="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="read Moby Dick chapter three" />
          <button type="submit">Settle</button>
        </form>
      </Section>
      {result && <ResultCard result={result} />}
      <Section title="Vocabulary">
        {vocabulary.tools.map((tool) => {
          const flags = [tool.confirm && 'confirm', tool.ai === false && 'no AI', tool.interrupt && 'interrupt', tool.contexts && `in ${tool.contexts.join(', ')}`].filter(Boolean);
          const args = Object.keys(tool.args ?? {});
          return (
            <div key={tool.id}>
              <span>
                {tool.id}
                {args.length ? `(${args.join(', ')})` : ''}
                {flags.length ? <span className="muted small"> · {flags.join(' · ')}</span> : null}
              </span>
              <ul className="mono" dir="auto">
                {(tool.phrases ?? []).flatMap((phrase) => phrase.say[language] ?? []).map((phrase, i) => (
                  <li key={i}>{phrase}</li>
                ))}
              </ul>
            </div>
          );
        })}
      </Section>
    </div>
  );
}
