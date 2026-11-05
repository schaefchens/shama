// AI providers for stage 3. The device's own model comes through the platform's port; these reach
// a model over the network, only in online mode, with credentials the app supplies per request –
// Shama keeps none.

import type { AiReply, AiRequest, Language, Why } from './types.ts';

export class AiError extends Error {
  readonly why: Why;

  constructor(why: Why, message: string) {
    super(message);
    this.name = 'AiError';
    this.why = why;
  }
}

export interface AiProvider {
  readonly name: string;
  available(language: Language): Promise<boolean>;
  /** One request per utterance: the words heard, framed as data, and the tools offered. */
  decide(request: AiRequest, signal: AbortSignal): Promise<AiReply>;
}

export interface OpenAiCompatibleOptions {
  /** The API's base, e.g. `https://api.openai.com/v1`, or a local server's. */
  baseURL: string;
  model: string;
  /** The headers for each request – an Authorization the app holds; asked for each time, never kept. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  fetch?: typeof fetch;
  name?: string;
}

/** Any server speaking OpenAI's chat completions with tools: OpenAI, Ollama, vLLM, OpenRouter… */
export function openAiCompatible(options: OpenAiCompatibleOptions): AiProvider {
  const send = options.fetch ?? fetch;
  return {
    name: options.name ?? `openai-compatible:${options.model}`,
    available: async () => true,
    async decide(request, signal) {
      const body = {
        model: options.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.message },
        ],
        tools: request.tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
        tool_choice: 'auto',
        ...(request.maxCalls === 1 ? { parallel_tool_calls: false } : {}),
      };
      let response: Response;
      try {
        response = await send(`${options.baseURL.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(await options.headers?.()) },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        throw new AiError(signal.aborted ? 'timeout' : 'unavailable', String(error));
      }
      if (!response.ok) throw new AiError('unavailable', `HTTP ${response.status}`);
      const json = (await response.json()) as {
        choices?: { finish_reason?: string; message?: { content?: unknown; tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[];
      };
      const choice = json.choices?.[0];
      if (choice?.finish_reason === 'content_filter') throw new AiError('refused', 'declined by the provider');
      if (choice?.finish_reason === 'length') throw new AiError('invalidReply', 'cut off');
      const calls = (choice?.message?.tool_calls ?? []).map((call) => {
        const tool = call.function?.name;
        if (!tool) throw new AiError('invalidReply', 'a tool call without a name');
        let args: Record<string, unknown> = {};
        try {
          args = call.function?.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
        } catch {
          throw new AiError('invalidReply', 'arguments that are not JSON');
        }
        return { tool, args };
      });
      const content = choice?.message?.content;
      return { calls, reply: typeof content === 'string' && content.trim() ? content.trim() : undefined };
    },
  };
}

/** A provider that answers as told – for tests and demos, in either mode. */
export function fakeProvider(
  decide: (request: AiRequest) => AiReply | Promise<AiReply>,
  options: { name?: string; available?: boolean; delayMs?: number } = {},
): AiProvider {
  return {
    name: options.name ?? 'fake',
    available: async () => options.available ?? true,
    async decide(request, signal) {
      if (options.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.delayMs);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new AiError('timeout', 'aborted'));
          });
        });
      }
      return decide(request);
    },
  };
}
