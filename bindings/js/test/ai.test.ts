import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiError, openAiCompatible } from '../src/index.ts';
import type { AiRequest } from '../src/index.ts';
import { anthropic } from '../src/anthropic.ts';

const request: AiRequest = {
  system: 'rules',
  message: '<heard lang="en">open the whale book</heard>',
  tools: [{ name: 'open', description: 'Opens a book', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
  maxCalls: 1,
};

const signal = new AbortController().signal;

test('OpenAI-compatible: the request, the calls, the headers asked for each time', async () => {
  let headersAsked = 0;
  const sent: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  let next: Response = reply({
    choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ function: { name: 'open', arguments: '{"book":"moby"}' } }] } }],
  });
  const provider = openAiCompatible({
    baseURL: 'http://localhost:11434/v1/',
    model: 'local',
    headers: () => ((headersAsked += 1), { authorization: 'Bearer from-the-app' }),
    fetch: async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
      return next;
    },
  });
  assert.deepEqual(await provider.decide(request, signal), { calls: [{ tool: 'open', args: { book: 'moby' } }], reply: undefined });
  assert.equal(sent[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(sent[0].headers.authorization, 'Bearer from-the-app');
  assert.deepEqual(sent[0].body.tool_choice, 'auto');
  assert.equal(sent[0].body.parallel_tool_calls, false);
  assert.deepEqual(sent[0].body.messages, [
    { role: 'system', content: 'rules' },
    { role: 'user', content: request.message },
  ]);

  next = reply({ choices: [{ finish_reason: 'content_filter', message: {} }] });
  await assert.rejects(provider.decide(request, signal), (error: AiError) => error.why === 'refused');
  next = reply({ choices: [{ finish_reason: 'stop', message: { tool_calls: [{ function: { name: 'open', arguments: '{bad' } }] } }] });
  await assert.rejects(provider.decide(request, signal), (error: AiError) => error.why === 'invalidReply');
  next = reply({}, 500);
  await assert.rejects(provider.decide(request, signal), (error: AiError) => error.why === 'unavailable');
  assert.equal(headersAsked, 4);
});

test("Anthropic: strict tools chosen freely, low effort, fallbacks where the model takes them", async () => {
  const params: Record<string, unknown>[] = [];
  const options: unknown[] = [];
  let message: Record<string, unknown> = {
    stop_reason: 'tool_use',
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: 'Opening it.' },
      { type: 'tool_use', id: 'toolu_1', name: 'open', input: { book: 'moby' } },
    ],
  };
  const client = {
    beta: {
      messages: {
        create: async (p: Record<string, unknown>, o: unknown) => {
          params.push(p);
          options.push(o);
          return message;
        },
      },
    },
  } as never;
  const opus = anthropic({ client, model: 'claude-opus-5-5' });
  assert.deepEqual(await opus.decide(request, signal), { calls: [{ tool: 'open', args: { book: 'moby' } }], reply: 'Opening it.' });
  const sent = params[0];
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.deepEqual(sent.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
  assert.equal((sent.tools as { strict: boolean }[])[0].strict, true);
  assert.deepEqual(sent.output_config, { effort: 'low' });
  assert.equal(sent.fallbacks, 'default');
  assert.deepEqual(sent.betas, ['server-side-fallback-2026-07-01']);
  assert.equal('thinking' in sent, false);
  assert.deepEqual(options[0], { signal });

  await anthropic({ client, model: 'claude-haiku-5-5' }).decide(request, signal);
  assert.equal('fallbacks' in params[1], false);

  message = { stop_reason: 'refusal', content: [] };
  await assert.rejects(opus.decide(request, signal), (error: AiError) => error.why === 'refused');
  message = { stop_reason: 'max_tokens', content: [] };
  await assert.rejects(opus.decide(request, signal), (error: AiError) => error.why === 'invalidReply');
});
