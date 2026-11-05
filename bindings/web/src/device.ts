// What the browser itself has: its voices, for Shama's replies – those on the device only, as a
// network voice would send the text away – and Chrome's built-in language model, where there is one.

import { AiError } from '@schaefchens/shama';
import type { AiReply, AiRequest, Language } from '@schaefchens/shama';

export function speak(text: string, language: Language): Promise<void> {
  const synth = globalThis.speechSynthesis;
  const voice = synth?.getVoices().find((voice) => voice.localService && voice.lang.toLowerCase().startsWith(language));
  if (!synth || !voice) return Promise.resolve();
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    synth.speak(utterance);
  });
}

export function stopSpeaking(): void {
  globalThis.speechSynthesis?.cancel();
}

interface LanguageModelSession {
  prompt(input: string, options?: { responseConstraint?: unknown; signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}

interface LanguageModelApi {
  availability(options: unknown): Promise<string>;
  create(options: unknown): Promise<LanguageModelSession>;
}

function languageModel(): LanguageModelApi | undefined {
  return (globalThis as { LanguageModel?: LanguageModelApi }).LanguageModel;
}

/** Chrome's built-in model, ready for the language – not one still to be downloaded. */
export async function modelAvailable(language: Language): Promise<boolean> {
  const api = languageModel();
  if (!api) return false;
  const io = [{ type: 'text', languages: [language] }];
  const availability = await api.availability({ expectedInputs: io, expectedOutputs: io }).catch(() => 'unavailable');
  return availability === 'available';
}

/** The built-in model asked for calls, its answer held to their shape by a JSON schema. */
export async function modelDecide(request: AiRequest, timeoutMs: number): Promise<AiReply> {
  const api = languageModel();
  if (!api) throw new AiError('unavailable', 'no built-in language model');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const session = await api.create({ initialPrompts: [{ role: 'system', content: request.system }], signal: controller.signal });
    const schema = {
      type: 'object',
      properties: {
        calls: {
          type: 'array',
          maxItems: request.maxCalls,
          items: {
            type: 'object',
            properties: { tool: { type: 'string', enum: request.tools.map((tool) => tool.name) }, args: { type: 'object' } },
            required: ['tool'],
          },
        },
        reply: { type: 'string' },
      },
      required: ['calls'],
    };
    const tools = request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
    try {
      const answer = await session.prompt(`${request.message}\n\nThe tools:\n${JSON.stringify(tools)}`, {
        responseConstraint: schema,
        signal: controller.signal,
      });
      return JSON.parse(answer) as AiReply;
    } finally {
      session.destroy();
    }
  } catch (error) {
    if (error instanceof AiError) throw error;
    throw new AiError(controller.signal.aborted ? 'timeout' : 'invalidReply', String(error));
  } finally {
    clearTimeout(timer);
  }
}
