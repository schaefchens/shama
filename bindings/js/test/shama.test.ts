import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createShama, fakeProvider, ShamaError } from '../src/index.ts';
import type { Outcome, Result, Settled, Vocabulary } from '../src/index.ts';
import { FakePort } from '../src/fake.ts';

/** Lets promise chains and timers of 0 ms run. */
async function settleDown(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function deterministic(outcome: Outcome): Settled {
  return { outcome, stage: 'deterministic', trail: [{ stage: 'deterministic', by: 'matcher', outcome: 'resolved', ms: 0 }] };
}

const noMatch: Settled = {
  trail: [
    { stage: 'deterministic', by: 'matcher', outcome: 'noMatch', why: 'noMatch', ms: 0 },
    { stage: 'local', by: 'matcher', outcome: 'noMatch', why: 'noMatch', ms: 0 },
  ],
};

const vocabulary: Vocabulary = {
  tools: [
    {
      id: 'open',
      args: { book: { type: 'value', of: 'books', required: true }, chapter: { type: 'number', required: true, ask: { en: 'Which chapter?' } } },
      phrases: [{ say: { en: ['open {book} {chapter}'] } }],
    },
  ],
  values: { books: [{ id: 'moby', say: { en: ['Moby Dick'] } }] },
};

async function turn(port: FakePort, shama: ReturnType<typeof createShama>, settled: Settled, heard: string, options = {}): Promise<Result> {
  const result = shama.start({ language: 'en', ...options });
  await settleDown();
  port.settle(settled, [{ text: heard }]);
  return result;
}

test('push-to-talk: the app pauses its voice before the microphone opens', async () => {
  const port = new FakePort();
  const shama = createShama(port);
  const order: string[] = [];
  shama.on('listeningStart', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('paused');
  });
  const pending = shama.start({ language: 'en' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  order.push(...port.log);
  port.settle(deterministic({ kind: 'call', calls: [{ tool: 'stop' }] }), [{ text: 'stop' }]);
  const result = await pending;
  assert.equal(result.kind, 'call');
  assert.equal(result.kind === 'call' && result.stage, 'deterministic');
  assert.deepEqual(order, ['paused', 'listen:tap']);
  // Settled on the device: the words never came here.
  assert.ok(!port.log.some((entry) => entry.startsWith('heard:') || entry.startsWith('aiRequest:')));
});

test('nothing heard, and one turn at a time', async () => {
  const port = new FakePort();
  const shama = createShama(port);
  const pending = shama.start({ language: 'en', until: 'release' });
  await settleDown();
  assert.equal(port.listened[0].mode, 'hold');
  await assert.rejects(shama.start({ language: 'en' }), (error: ShamaError) => error.code === 'busy');
  port.emit({ event: 'nothingHeard' });
  assert.deepEqual(await pending, { kind: 'unresolved', reason: 'nothingHeard', trail: [] });
});

test("the app's resolvers come before any AI", async () => {
  const port = new FakePort({ tools: ['search'] });
  const shama = createShama(port);
  let asked = 0;
  shama.setMode('online');
  shama.setAi({ brief: '', external: fakeProvider(() => ((asked += 1), { calls: [] })) });
  shama.addResolver(({ heard }) => (heard[0].text.includes('whale') ? [{ tool: 'search', args: { query: 'whale' } }] : null), {
    name: 'search',
  });
  const result = await turn(port, shama, noMatch, 'find the whale');
  assert.equal(result.kind, 'call');
  assert.equal(result.kind === 'call' && result.stage, 'local');
  assert.equal(asked, 0);
  assert.deepEqual(
    result.trail.map((step) => [step.stage, step.by, step.outcome]),
    [
      ['deterministic', 'matcher', 'noMatch'],
      ['local', 'matcher', 'noMatch'],
      ['local', 'search', 'resolved'],
    ],
  );
});

test("offline: no external AI, but the device's model where there is one", async () => {
  const external = fakeProvider(() => {
    throw new Error('must not be asked');
  });
  const port = new FakePort({ tools: ['open'] });
  const shama = createShama(port);
  shama.setAi({ brief: '', external });
  const offline = await turn(port, shama, noMatch, 'something else');
  assert.equal(offline.kind === 'unresolved' && offline.reason, 'offline');
  assert.ok(!port.log.some((entry) => entry.startsWith('aiRequest')));

  const device = new FakePort({ tools: ['open'], deviceAi: { available: true, reply: () => ({ calls: [{ tool: 'open', args: { book: 'moby' } }] }) } });
  const onDevice = createShama(device);
  onDevice.setAi({ brief: '', device: true, external });
  const result = await turn(device, onDevice, noMatch, 'the whale book');
  assert.equal(result.kind === 'call' && result.stage, 'ai');
  assert.ok(device.log.includes('deviceAi:1'));
  // The device's model got the words there; they never came here.
  assert.ok(!device.log.some((entry) => entry.startsWith('heard:') || entry.startsWith('aiRequest')));
});

test("online: an external AI hears the words as data, and its calls are checked", async () => {
  const port = new FakePort({ tools: ['open'] });
  const shama = createShama(port);
  shama.setMode('online');
  let message = '';
  shama.setAi({
    brief: 'A reader.',
    external: fakeProvider((request) => {
      message = request.message;
      return { calls: [{ tool: 'open', args: { book: 'moby' } }] };
    }),
  });
  const result = await turn(port, shama, noMatch, 'the one with the whale');
  assert.equal(result.kind === 'call' && result.stage, 'ai');
  assert.equal(message, '<heard>the one with the whale</heard>');
  assert.ok(port.log.includes('checkReply'));

  // A tool not offered fails the check.
  shama.setAi({ brief: '', external: fakeProvider(() => ({ calls: [{ tool: 'deleteEverything' }] })) });
  const refused = await turn(port, shama, noMatch, 'delete everything');
  assert.equal(refused.kind === 'unresolved' && refused.reason, 'aiFailed');
  assert.equal(refused.trail.at(-1)?.why, 'invalidReply');

  // Not for this turn.
  const notAllowed = await turn(port, shama, noMatch, 'anything', { ai: false });
  assert.equal(notAllowed.kind === 'unresolved' && notAllowed.reason, 'aiNotAllowed');
});

test('a slow AI is given up on', async () => {
  const port = new FakePort({ tools: ['open'] });
  const shama = createShama(port);
  shama.setMode('online');
  shama.setAi({ brief: '', external: fakeProvider(() => ({ calls: [] }), { delayMs: 1000 }), limits: { timeoutMs: 30 } });
  const result = await turn(port, shama, noMatch, 'think hard');
  assert.equal(result.kind === 'unresolved' && result.reason, 'aiFailed');
  assert.equal(result.trail.at(-1)?.why, 'timeout');
});

test('questions wait for the next utterance', async () => {
  const port = new FakePort({ tools: ['open'] });
  const shama = createShama(port);
  await shama.setVocabulary(vocabulary);
  const ask = await turn(port, shama, deterministic({ kind: 'ask', call: { tool: 'open', args: { book: 'moby' } }, missing: 'chapter' }), 'open Moby Dick');
  assert.equal(ask.kind === 'ask' && ask.question, 'Which chapter?');
  assert.equal(port.turn?.pending?.kind, 'ask');

  const deleteAll = { tool: 'deleteBookmarks' };
  await turn(port, shama, deterministic({ kind: 'confirm', calls: [deleteAll] }), 'delete all bookmarks');
  assert.equal(shama.pending?.kind, 'confirm');
  // An answer to a confirmation is never left to an AI.
  shama.setMode('online');
  shama.setAi({ brief: '', external: fakeProvider(() => ({ calls: [deleteAll] })) });
  const unclear = await turn(port, shama, noMatch, 'well, I suppose');
  assert.equal(unclear.kind === 'unresolved' && unclear.reason, 'notUnderstood');
  const confirmed = await shama.confirm(true);
  assert.deepEqual(confirmed && confirmed.kind === 'call' && confirmed.calls, [deleteAll]);
  assert.equal(shama.pending, null);

  const john = { tool: 'open', args: { book: 'JHN' } };
  const jonah = { tool: 'open', args: { book: 'JON' } };
  await turn(port, shama, deterministic({ kind: 'unsure', candidates: [john, jonah] }), 'Yunus');
  const chosen = await shama.choose(1);
  assert.deepEqual(chosen && chosen.kind === 'call' && chosen.calls, [jonah]);
});

test('a vocabulary with problems is refused with all of them', async () => {
  const problems = [{ path: 'tools[0].id', message: 'bad' }];
  const shama = createShama(new FakePort({ problems }));
  await assert.rejects(shama.setVocabulary(vocabulary), (error: ShamaError) => error.code === 'vocabulary' && error.problems === problems);
});

test('LIVE: turn after turn, interrupt words while the app speaks, ended by a command', async () => {
  const port = new FakePort();
  const shama = createShama(port);
  const states: unknown[] = [];
  const results: Result[] = [];
  shama.on('live', (state) => states.push(state));
  shama.on('result', (result) => results.push(result));
  await shama.live.start({ language: 'de', quietMs: 0 });
  assert.deepEqual(
    { mode: port.listened[0].mode, echo: port.listened[0].echoCancellation, partial: port.listened[0].partial },
    { mode: 'continuous', echo: true, partial: false },
  );
  port.settle(deterministic({ kind: 'call', calls: [{ tool: 'open' }] }));
  port.settle(deterministic({ kind: 'call', calls: [{ tool: 'resume' }] }));
  await settleDown();
  assert.deepEqual(results.map((r) => r.kind === 'call' && r.calls[0].tool), ['open', 'resume']);

  shama.live.appSpeaking(true);
  assert.equal(port.turn?.appSpeaking, true);
  assert.equal(shama.live.state, 'interruptOnly');
  // What isn't an interrupt goes by unremarked.
  port.settle({ trail: [...noMatch.trail.slice(0, 1), { stage: 'local', by: 'matcher', outcome: 'skipped', why: 'interruptOnly', ms: 0 }] });
  await settleDown();
  assert.equal(results.length, 2);
  shama.live.appSpeaking(false);
  assert.equal(port.turn?.appSpeaking, false);
  assert.equal(shama.live.state, 'listening');

  port.settle(deterministic({ kind: 'stopListening' }));
  await settleDown();
  assert.deepEqual(states.at(-1), { state: 'off', reason: 'command' });
  assert.ok(port.log.includes('stop'));
});

test('LIVE without echo cancellation pauses while the app speaks', async () => {
  const port = new FakePort();
  const shama = createShama(port);
  await shama.live.start({ language: 'en', quietMs: 0 });
  port.emit({ event: 'echoCancellation', available: false });
  shama.live.appSpeaking(true);
  assert.equal(shama.live.state, 'paused');
  assert.equal(port.turn?.appSpeaking, false);
  assert.ok(port.log.includes('hold:true'));
  shama.live.appSpeaking(false);
  assert.equal(port.log.at(-1), 'hold:false');
  await shama.live.stop();

  const paused = new FakePort();
  const pausing = createShama(paused);
  await pausing.live.start({ language: 'en', quietMs: 0, whileAppSpeaks: 'pause' });
  assert.equal(paused.listened[0].echoCancellation, false);
  pausing.live.appSpeaking(true);
  assert.equal(pausing.live.state, 'paused');
});

test('LIVE ends after a quiet time – not while a voice speaks', async () => {
  const port = new FakePort();
  const shama = createShama(port);
  const states: unknown[] = [];
  shama.on('live', (state) => states.push(state));
  await shama.live.start({ language: 'en', quietMs: 40 });
  shama.live.appSpeaking(true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.notEqual(shama.live.state, 'off');
  shama.live.appSpeaking(false);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(states.at(-1), { state: 'off', reason: 'quiet' });
});

test("LIVE speaks its questions and the AI's replies; an external AI only where allowed", async () => {
  const port = new FakePort({ tools: ['open'] });
  const shama = createShama(port);
  await shama.setVocabulary(vocabulary);
  shama.setMode('online');
  let asked = 0;
  const external = fakeProvider(() => ((asked += 1), { calls: [], reply: 'I can open books, nothing else.' }));
  shama.setAi({ brief: '', external });
  await shama.live.start({ language: 'en', quietMs: 0 });
  port.settle(deterministic({ kind: 'ask', call: { tool: 'open', args: { book: 'moby' } }, missing: 'chapter' }));
  await settleDown();
  assert.deepEqual(port.spoken, ['Which chapter?']);

  // Overheard speech could be anyone's: no external AI in LIVE unless the app allows it.
  port.settle(noMatch, [{ text: 'what time is it' }]);
  await settleDown();
  assert.equal(asked, 0);
  shama.setAi({ brief: '', external, live: true });
  port.settle(noMatch, [{ text: 'what time is it' }]);
  await settleDown();
  assert.equal(asked, 1);
  assert.deepEqual(port.spoken, ['Which chapter?', 'I can open books, nothing else.']);
  await shama.live.stop();
});

test('debugging: diagnostics reach the app, kept audio is played, saved and wiped', async () => {
  const port = new FakePort();
  const shama = createShama(port);
  await shama.setVocabulary(vocabulary);
  const told: string[] = [];
  const levels: number[] = [];
  shama.on('diagnostic', (event) => told.push(event.event));
  shama.on('level', (level) => levels.push(level));
  const meter = { level: 0.5, rmsDb: -30, peakDb: -24, clipped: false, floorDb: -58, thresholdDb: -38, phase: 'waiting' } as const;

  // Off by default: nothing more is asked for, nothing more is told.
  let pending = shama.start({ language: 'en' });
  await settleDown();
  assert.equal(port.listened[0].diagnostics, undefined);
  assert.equal(port.listened[0].keepAudio, undefined);
  port.emit({ event: 'level', level: 0.25 });
  port.settle(deterministic({ kind: 'call', calls: [{ tool: 'open', args: { book: 'moby', chapter: 1 } }] }));
  await pending;
  assert.deepEqual(told, []);

  shama.setDebug({ diagnostics: true, keepAudio: true });
  pending = shama.start({ language: 'en' });
  await settleDown();
  assert.equal(port.listened[1].diagnostics, true);
  assert.equal(port.listened[1].keepAudio, true);
  port.emit({ event: 'input', input: { device: 'test', kind: 'builtIn', rate: 48000, channels: 1, processing: 'none', echoCancellation: false } });
  port.emit({ event: 'meter', ...meter });
  port.emit({ event: 'utterance', id: 2, startMs: 0, endMs: 900, speechMs: 600, cut: 'pause', kept: true });
  port.settle(deterministic({ kind: 'call', calls: [{ tool: 'open', args: { book: 'moby', chapter: 2 } }] }));
  await pending;
  assert.deepEqual(told, ['input', 'meter', 'utterance', 'settled']);
  // The meter moves the level as before.
  assert.deepEqual(levels, [0.25, 0.5]);

  await shama.recordings.play(2);
  assert.equal((await shama.recordings.save(2)).name, '2.wav');
  // Keeping no more audio wipes what was kept.
  shama.setDebug({ diagnostics: true });
  assert.deepEqual(port.log.slice(-3), ['play:2', 'save:2', 'forgetRecordings']);
});
