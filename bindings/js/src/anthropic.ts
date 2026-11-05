// Claude as Shama's stage-3 AI, through the app's own Anthropic client: its key or its proxy, its
// fetch, its platform. One request per utterance; tools offered with strict schemas and chosen
// freely (`auto` – forced tool choice isn't taken by current models); a refusal is a failure, not
// a reply.

import type Anthropic from '@anthropic-ai/sdk';
import { AiError } from './ai.ts';
import type { AiProvider } from './ai.ts';

export interface AnthropicOptions {
  /** The app's client – `new Anthropic({ baseURL })` to a proxy holding the key, say. */
  client: Anthropic;
  /** The model, chosen by the app – e.g. `claude-opus-5-5`. */
  model: string;
  /** How hard it thinks: a voice command wants an answer quickly. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
  /**
   * Server-side fallbacks when the model declines (Claude API, Claude Platform on AWS): on by
   * default for the models that take them. Off for other platforms.
   */
  fallbacks?: boolean;
  name?: string;
}

const FALLBACK_MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];

export function anthropic(options: AnthropicOptions): AiProvider {
  const fallbacks = (options.fallbacks ?? true) && FALLBACK_MODELS.includes(options.model);
  return {
    name: options.name ?? `anthropic:${options.model}`,
    available: async () => true,
    async decide(request, signal) {
      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await options.client.beta.messages.create(
          {
            model: options.model,
            max_tokens: options.maxTokens ?? 4096,
            system: request.system,
            messages: [{ role: 'user', content: request.message }],
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters as Anthropic.Beta.BetaTool.InputSchema,
              strict: true,
            })),
            tool_choice: { type: 'auto', disable_parallel_tool_use: request.maxCalls === 1 },
            output_config: { effort: options.effort ?? 'low' },
            // The rules and the tools repeat from turn to turn: cached, they come back faster.
            cache_control: { type: 'ephemeral' },
            ...(fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
          },
          { signal },
        );
      } catch (error) {
        throw new AiError(signal.aborted ? 'timeout' : 'unavailable', String(error));
      }
      if (message.stop_reason === 'refusal') throw new AiError('refused', 'declined by the model');
      if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
        throw new AiError('invalidReply', 'cut off');
      }
      const calls: { tool: string; args?: Record<string, unknown> }[] = [];
      const texts: string[] = [];
      for (const block of message.content) {
        if (block.type === 'tool_use') calls.push({ tool: block.name, args: block.input as Record<string, unknown> });
        else if (block.type === 'text') texts.push(block.text);
      }
      const reply = texts.join(' ').trim();
      return { calls, reply: reply || undefined };
    },
  };
}
