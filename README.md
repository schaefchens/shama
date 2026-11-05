# Shama

Voice commands and a voice assistant for apps – on the device first.

Your app tells Shama what it can do: its **tools** – "open a book at a chapter", "next", "stop" – and the phrases people say for them in each language. Shama listens, recognizes the words on the device and settles them in stages, each only where the one before couldn't:

1. **Deterministic:** the app's phrases, names and numbers, matched whole – "read Moby Dick chapter forty-two", "lies das dritte Kapitel von Faust".
2. **Best effort on the device:** looser matching, filler words dropped, the app's own resolvers – its search, say.
3. **AI:** a language model gets the words heard and only the tools the moment needs – the device's own model, or, online, a provider the app chooses – and answers with calls to them, which Shama checks.

The app gets calls to its tools, never audio. People talk by a button – push-to-talk – or in **LIVE**, a conversation that goes on, Shama answering aloud, until they end it.

Shama runs inside apps on iOS and Android (React Native, an Expo module) and in the browser, with one TypeScript API and React hooks for all of them. Its core is in Rust. It is young: built in November 2026, not on npm yet.

### Made with AI

Shama was written with an AI model – Anthropic's Claude, through Claude Code – under its maintainer's direction: the code, its tests and these documents. Its tests run in CI and in three browsers; what they show is below. It has had no review by a speech or security expert yet: weigh that before your users depend on it.

## What it gives your app

- **Your vocabulary, your tools:** phrases with optional words, choices and slots – `[read|open] {book} [chapter] {chapter}` – named values with their spoken forms, numbers. Checked as a whole: one phrase meaning two calls is an error, with its path, before anything is heard.
- **Five languages from the start:** English, German, Turkish, Arabic and Persian – case and letter forms, Arabic and Persian marks, digits in three scripts, and numbers from 0 to 999 in words: German compounds, Turkish and Persian ordinals, Arabic genders and cases.
- **Context:** "next" means the next chapter while reading and the next book in the library – the screen in front first. What the app is at fills what goes unsaid: "verse 16" while reading John 3.
- **Questions:** a missing argument is asked for, a consequential tool confirmed, two candidates offered – answered by the next utterance or a button.
- **On the device:** the system's recognizer held there – Apple's and Google's – or an embedded one; the system's language model where it has one. Offline, nothing leaves the device.
- **AI only last, and only as allowed:** online, an AI you choose – any OpenAI-compatible server, or Claude through your own Anthropic client – gets text, never audio, and only the tools of the moment; never one you mark `ai: false`.
- **LIVE:** utterance after utterance; while your app speaks, only its interrupt tools count, on echo-cancelled input where the platform cancels echo, or Shama pauses.

## Is it for your project?

Shama fits apps whose commands people can name – readers, audiobook and media players, tools with a known set of actions – and that care where speech goes. What it costs:

- **Recognition quality is the device's:** biasing helps with names, but a system recognizer is no grammar; an embedded one costs tens of megabytes per language (see [engines.md](docs/engines.md)).
- **A vocabulary to write:** phrases in every language you serve – best reviewed by native speakers.
- **Maturity:** a preview; tested on simulators, emulators and browsers, not yet on phones.

| Alternative | What it does well | What it leaves out, compared with Shama |
| --- | --- | --- |
| **The platform's dictation** – `SFSpeechRecognizer`, Android's `SpeechRecognizer`, the Web Speech API | Free, good at free text | Text, not your tools; you write the matching, numbers and questions. The Web Speech API sends audio to a server in Chrome and is missing in others |
| **Picovoice Rhino** | Speech-to-intent on the device, small, fast | Proprietary, licensed per app; no AI stage for what it can't parse |
| **Vosk or Whisper alone** | Open models, constrained grammars (Vosk), strong free text (Whisper) | An engine, not a pipeline: capture, endpointing, matching, contexts and questions are yours; Whisper is weak in Persian at small sizes |
| **An LLM with tools, directly** | Understands free requests | Slow, costs, needs a network, and can be wrong on the simplest commands – Shama asks it only when the device couldn't settle them |

## Install

Not on npm yet: build from source. Rust through rustup with the iOS, Android and wasm32 targets, cargo-ndk, wasm-bindgen-cli 0.2.129, Node 22.18 or later, Xcode, the Android SDK.

```sh
npm install                              # the workspace: packages and examples
sh bindings/react-native/build.sh        # the core for iOS and Android, and its Swift and Kotlin bindings
sh bindings/web/build.sh                 # the core as WASM
```

- **React Native:** `@schaefchens/shama-react-native` is an Expo module (Expo SDK 58, React Native 0.88, iOS 16.4, Android API 24); its config plugin takes the microphone's and the speech recognizer's usage texts. Not in Expo Go.
- **Web:** `@schaefchens/shama-web` runs the core in a worker and needs a bundler that handles `new Worker(new URL(…, import.meta.url))` – Vite does.
- **React:** `@schaefchens/shama-react` has the hooks, for both.

## Use

```ts
import { createNativeShama } from '@schaefchens/shama-react-native'; // or createWebShama from '@schaefchens/shama-web'

const shama = createNativeShama();
await shama.setVocabulary({
  tools: [
    {
      id: 'open',
      args: { book: { type: 'value', of: 'books', required: true }, chapter: { type: 'number', min: 1, max: 200 } },
      phrases: [{ say: { en: ['[read|open] {book} [[chapter] {chapter}]'], de: ['[lies|öffne] {book} [[kapitel] {chapter}]'] } }],
    },
    { id: 'stop', interrupt: true, phrases: [{ say: { en: ['stop'], de: ['(stopp|halt)'] } }] },
  ],
  values: { books: [{ id: 'moby', say: { en: ['Moby Dick'], de: ['Moby Dick'] } }] },
});
shama.on('listeningStart', () => player.pause()); // before the microphone opens
const result = await shama.start({ language: 'en', until: 'release' }); // the talk button down; shama.stop() when it's let go
if (result.kind === 'call') for (const call of result.calls) run(call);
```

- **LIVE:** `shama.live.start({ language, whileAppSpeaks: 'interrupt' })`, `shama.live.appSpeaking(true)` while your app's voice speaks, results through `shama.on('result', …)`.
- **Context and state:** `shama.setContext({ contexts: ['reading'], state: { book: 'moby', chapter: 3 } })` – or `useShamaContext` per screen.
- **AI:** `shama.setAi({ brief, device: true, external: anthropic({ client, model: 'claude-opus-5-5' }) })` and `shama.setMode('online')`.
- **Your own stage 2:** `shama.addResolver(({ heard }) => search(heard[0].text))`.

[examples/react-native](examples/react-native) and [examples/web](examples/web) are a whole app each: an audiobook reader's voice control in five languages, with a self-test.

## How it works

- **The core** (Rust, `src/`) holds the vocabulary, normalization, numbers, the matcher, the AI's tool schemas and checks, the resampler and the endpointer, and settles every utterance on the device. Native code reaches it through UniFFI (`bindings/ffi`), the web's worker through wasm-bindgen (`bindings/wasm`).
- **The platforms** bring the microphone – AVAudioEngine, AudioRecord, an AudioWorklet – the system's recognizer and language model, and a voice. Audio goes from the microphone to the core without passing through JavaScript; what was heard stays there until a stage in JavaScript needs the words.
- **The pipeline** (TypeScript, `bindings/js`) runs what follows the device's stages: the app's resolvers, the AI, the questions, LIVE.

[docs/design.md](docs/design.md) has the decisions and why; [docs/engines.md](docs/engines.md) which recognizer serves which language.

## Scope

- No wake word: push-to-talk, or LIVE switched on.
- Foreground only: an app that leaves the screen stops listening.
- No recordings, no transcripts kept, nothing of what was said logged.
- Numbers up to 999; more languages need their rules in the core.

## Repository

| Path | What |
| --- | --- |
| `src/` | The core |
| `bindings/ffi`, `bindings/uniffi-bindgen` | The core for Swift and Kotlin |
| `bindings/wasm` | The core for the web |
| `bindings/js` | `@schaefchens/shama`: the pipeline, the AI providers, the self-test |
| `bindings/react-native` | `@schaefchens/shama-react-native`: the Expo module |
| `bindings/web` | `@schaefchens/shama-web`: the worker, the AudioWorklet |
| `bindings/react` | `@schaefchens/shama-react`: the hooks |
| `examples/react-native`, `examples/web` | The examples |
| `tests/` | The core's tests and fixtures: the examples' vocabulary, rows of what recognizers might hear, the self-test's cases |
| `tools/` | The fixture recordings, the measuring tools |
| `docs/` | Decisions and measurements |

## What the tests show

November 2026:

- **The core:** numbers 0–999 read back from every spelling in five languages; 131 rows of what recognizers might hear – near misses and speech not meant for the app among them – settled as they must be; the endpointer on synthesized speech, clicks and silence; the resampler keeps speech level and folds nothing back above 8 kHz (below −60 dB); recordings through the whole pipeline, push-to-talk and LIVE.
- **The pipeline:** stage order, no AI before the device's stages; external AI blocked offline and in LIVE unless allowed; a confirmation never left to an AI; slow AIs given up on; LIVE's interrupts, pauses, quiet time and "stop listening"; both AI providers' requests and answers.
- **The self-test** – recordings in five languages, nothing heard, a LIVE conversation, a turn settled by a fake AI – passes through the core as WASM in Node, and in Chromium, Firefox and WebKit.

## License

Apache 2.0 – see [LICENSE](LICENSE).
