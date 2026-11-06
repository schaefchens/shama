// The demo's few building blocks.

import type { ReactNode } from 'react';

export function Section({ title, right, children, testId }: { title: string; right?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="section" data-testid={testId}>
      <div className="section-head">
        <h2>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row">
      <span className="label">{label}</span>
      <div className="chips">{children}</div>
    </div>
  );
}

export function Chip(props: { label: string; selected?: boolean; disabled?: boolean; onClick: () => void; testId?: string }) {
  return (
    <button type="button" aria-pressed={props.selected ?? false} disabled={props.disabled} onClick={props.onClick} data-testid={props.testId}>
      {props.label}
    </button>
  );
}

export function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="muted small"> – {hint}</span>}
      </span>
    </label>
  );
}
