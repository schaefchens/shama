// Everything Shama told, a line each, the newest last: to read, copy and clear.

import type { Diagnostics } from '@schaefchens/shama-react';
import { stamp } from '../../shared/demo';
import { Chip, Section } from './ui';

export function Log({ diagnostics }: { diagnostics: Diagnostics }) {
  const text = diagnostics.log.map((entry) => `${stamp(entry.at)}  ${entry.text}`).join('\n');
  return (
    <Section
      title={`Log (${diagnostics.log.length})`}
      testId="log"
      right={
        <div className="actions">
          <Chip label="Copy" onClick={() => void navigator.clipboard?.writeText(text)} />
          <Chip label="Clear" onClick={diagnostics.clear} />
        </div>
      }
    >
      {text ? <pre className="log mono">{text}</pre> : <span className="muted small">Nothing yet: talk, hear a WAV, or settle a text.</span>}
    </Section>
  );
}
