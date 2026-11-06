export { createShama, ShamaError } from './shama.ts';
export type {
  AiLimits,
  AiSettings,
  DebugOptions,
  ErrorCode,
  Live,
  LiveEnd,
  LiveOptions,
  LiveState,
  Recordings,
  Resolver,
  Shama,
  ShamaEvents,
  StartOptions,
} from './shama.ts';
export { AiError, fakeProvider, openAiCompatible } from './ai.ts';
export type { AiProvider, OpenAiCompatibleOptions } from './ai.ts';
export type {
  AiOptions,
  Cut,
  Endpointing,
  InputInfo,
  LanguageSupport,
  ListenMode,
  ListenOptions,
  Meter,
  Port,
  PortEvent,
  RecognizerChoice,
  SavedRecording,
  UtteranceCut,
} from './port.ts';
export type * from './types.ts';
export { selfTest } from './selftest.ts';
export type { SelfTestCase, SelfTestReport } from './selftest.ts';
