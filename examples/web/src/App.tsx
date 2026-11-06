// Shama's demo in a browser: an audiobook reader's voice control, with all Shama tells for
// debugging – the microphone, the meter, each utterance kept to play, save and hear again, a log.
// `?self-test` runs the self-test instead.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LanguageSupport } from '@schaefchens/shama';
import { ShamaProvider, useDiagnostics, useListening, useShama, useShamaContext } from '@schaefchens/shama-react';
import { createWebShama } from '@schaefchens/shama-web';
import { ai, initialSettings, rtl, vocabulary } from '../../shared/demo';
import type { DemoSettings } from '../../shared/demo';
import { Listen } from './Listen';
import { Log } from './Log';
import { Setup } from './Setup';
import { TryText } from './TryText';
import { Chip } from './ui';

const tabs = ['Listen', 'Setup', 'Text', 'Log'] as const;
type Tab = (typeof tabs)[number];

export function App() {
  const shama = useMemo(() => createWebShama(), []);
  return (
    <ShamaProvider shama={shama}>
      <Demo />
    </ShamaProvider>
  );
}

function Demo() {
  const shama = useShama();
  const [tab, setTab] = useState<Tab>('Listen');
  const [settings, setSettings] = useState<DemoSettings>(initialSettings);
  const [error, setError] = useState<string | null>(null);
  const [support, setSupport] = useState<LanguageSupport[]>([]);
  const listening = useListening();
  const diagnostics = useDiagnostics();
  useShamaContext([settings.context]);
  const update = useCallback((change: Partial<DemoSettings>) => setSettings((now) => ({ ...now, ...change })), []);

  useEffect(() => {
    shama.setVocabulary(vocabulary).catch((e: Error) => setError(e.message));
    shama.setAi(ai);
    return shama.on('error', (e) => setError(`${e.code}: ${e.message}`));
  }, [shama]);
  useEffect(() => shama.setMode(settings.mode), [shama, settings.mode]);
  useEffect(() => shama.setDebug({ diagnostics: settings.diagnostics, keepAudio: settings.keepAudio }), [shama, settings.diagnostics, settings.keepAudio]);
  const refresh = useCallback(() => void shama.languages().then(setSupport, (e: Error) => setError(e.message)), [shama]);
  // Again with each language: an engine configured meanwhile is found.
  useEffect(refresh, [refresh, settings.language]);

  return (
    <main dir={rtl(settings.language) ? 'rtl' : 'ltr'}>
      <header>
        <h1>Shama</h1>
        <span className="muted small" data-testid="status">
          {listening.state}
          {listening.stage ? ` (${listening.stage})` : ''} · LIVE {listening.live}
        </span>
      </header>
      <nav className="tabs">
        {tabs.map((name) => (
          <Chip key={name} label={name} testId={`tab-${name}`} selected={tab === name} onClick={() => setTab(name)} />
        ))}
        <a className="small" href="?self-test">
          Self-test
        </a>
      </nav>
      {error && (
        <p className="error" role="alert">
          {error} <button onClick={() => setError(null)}>×</button>
        </p>
      )}
      <div hidden={tab !== 'Listen'}>
        <Listen settings={settings} update={update} diagnostics={diagnostics} onError={setError} />
      </div>
      <div hidden={tab !== 'Setup'}>
        <Setup settings={settings} update={update} live={listening.live !== 'off'} support={support} refresh={refresh} />
      </div>
      <div hidden={tab !== 'Text'}>
        <TryText settings={settings} onError={setError} />
      </div>
      <div hidden={tab !== 'Log'}>
        <Log diagnostics={diagnostics} />
      </div>
    </main>
  );
}
