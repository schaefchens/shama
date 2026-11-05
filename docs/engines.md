# Recognizers – what was measured

2026-11-05. Set-up:
- a MacBook Pro (Apple silicon, macOS 15.7.5);
- the Android 16 emulator with Google Play (`shama_play`, arm64), emulator 37.2.13 for every recognition run and 37.1.11 for the first probe;
- Chrome for Testing 156 and Brave 156, headless.

There was no phone. The tools are in [tools/](../tools); the corpus, the models and the runs are in `.cache/`, not in git.

## Corpus

- **Per language** (en, de, tr, ar, fa):
  - 300 commands: 19 fixed ones ("stop", "next verse", "where am I" …) three times each, the rest templates filled with names (neutral books, Bible books, surahs) and numbers 1–300;
  - 30 near misses ("stop the car at the corner") and 30 everyday sentences;
  - 100 FLEURS test sentences read by people (CC BY 4.0);
  - 6 noise files: pink, white, hum, clicks, silence;
  - 60 commands in 7 variants: ×0.9 and ×1.15 speed, pink noise at 20, 10 and 5 dB SNR, −35 and −20 dBFS.
- **Voices:**
  - macOS voices for en (10) and de (9, eight of them the robotic Eloquence voices);
  - OpenAI's gpt-4o-mini-tts (8 voices) for tr, ar and fa, plus Yelda (tr) and Majed (ar).
  - This is synthetic speech, harder than people: the Eloquence voices, and OpenAI's accents in Arabic and Persian. Arabic shows it most: Whisper small got 65 % exactly right from Majed and 29 % from the OpenAI voices, Omnilingual 38 % and 13 %. FLEURS is the check with real voices.
- **Padding:** every utterance gets 300 ms of silence before and 400 ms after, as Shama's endpointer keeps around speech.
- **Scoring** (`tools/corpus/score.mjs`): case, punctuation, Arabic and Persian marks and letter variants, and German and Turkish diacritics are folded; number words are read as digits.
  - *Exact*: the same text.
  - *Close*: the numbers exact and the letters within one edit in eight – about what a tolerant whole-utterance matcher forgives.
  - *Accepted*: a near miss, sentence, FLEURS sentence or noise that would match a command template whole.
  - WER for en, de and tr; CER for ar and fa.

## Availability

| | Apple, on the device (macOS here) | Android 33+, Google on the device | Web | Embedded (sherpa-onnx) |
| --- | --- | --- | --- | --- |
| en | ✓ | ✓, a 62 MB download | Chromium: downloadable · Brave: none | ✓ |
| de | ✓ | ✓, 58 MB | Chromium: downloadable · Brave: none | ✓ |
| tr | listed, not on the device here | ✓, 40 MB | Chromium: downloadable · Brave: none | ✓ |
| ar | listed (ar-SA), not on the device here | – | none | ✓, weak |
| fa | – | – | none | ✓ |

- **Apple:**
  - `supportedLocales` has tr-TR and ar-SA, but `supportsOnDeviceRecognition` is false for both on this Mac; fa-IR doesn't exist.
  - Whether an iPhone with the Dictation language installed recognizes tr and ar on the device needs a phone.
  - Speech recognition asks for its own permission, beside the microphone's.
- **Android:**
  - `checkRecognitionSupport` offers 31 languages on the device – not Arabic, not Persian.
  - `triggerModelDownload` shows a system dialog (Download / Cancel).
  - Shama's own audio goes in through `EXTRA_AUDIO_SOURCE` (a pipe), and the recognizer takes it.
  - The final `onResults` bundle comes back **empty**. The hearing arrives only in a segmented session (`EXTRA_SEGMENTED_SESSION` = `EXTRA_AUDIO_SOURCE`, through `onSegmentResults`), as one hypothesis with confidence 0.
  - `EXTRA_BIASING_STRINGS` changed nothing: biased and unbiased runs gave the same hearings in en and tr, and in de too.
- **Web:**
  - Chromium 156 has on-device Web Speech (`processLocally`): en was downloading, de and tr downloadable, ar and fa unavailable.
  - Brave has the API but nothing on the device, and no Prompt API model.
  - So the web is embedded only.

## Commands and free speech

The embedded models ran on the Mac with 2 threads. Apple and Android were fed as fast as they take audio.

| Recognizer | Lang | Commands exact / close % | Fixed / names+numbers close % | 10 dB SNR close % | FLEURS WER/CER % | Decode p50 / p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| Shenava Koochik | fa | 60.7 / 81.3 | 93.0 / 78.6 | 71.7 | 3.8 | 175 / 280 |
| Shenava Rizeh | fa | 47.0 / 79.3 | 94.7 / 75.7 | 60.0 | 6.2 | 64 / 102 |
| Shenava Pizeh | fa | 23.0 / 55.0 | 75.4 / 50.2 | 21.7 | 12.3 | 33 / 52 |
| Dolphin base | fa | 5.7 / 15.7 | 15.8 / 15.6 | 6.7 | 12.9 | 187 / 376 |
| Google on the device | tr | 88.0 / 92.0 | 98.2 / 83.7 | – | 12.4 | 221 / 382 ² |
| seda | tr | 61.3 / 81.0 | 91.2 / 78.6 | 55.0 | 17.1 | 111 / 179 |
| Google on the device | de | 34.0 / 34.7 | 77.2 / 8.6 | – | 14.7 | 210 / 1122 ² |
| Apple, contextualStrings (commands only) | de | 26.7 / 32.0 | 98.2 / 16.5 | – | – | 519 / 1587 ² |
| Apple, unbiased | de | 20.7 / 25.3 | 82.5 / 11.9 | – | – ¹ | 702 / 2588 ² |
| NeMo FastConformer de (transducer) | de | 24.3 / 37.3 | 75.4 / 28.4 | 10.0 | 6.6 | 141 / 226 |
| NeMo FastConformer en-de-es-fr (CTC) | de | 12.3 / 23.3 | 43.9 / 18.5 | 8.3 | 7.5 | 141 / 219 |
| Google on the device | en | 65.0 / 70.0 | 82.5 / 53.5 | – | 15.6 | 89 / 375 ² |
| Apple, contextualStrings | en | 56.3 / 59.7 | 94.7 / 51.4 | 56.7 | – ¹ | 314 / 1628 ² |
| Apple, unbiased | en | 51.0 / 54.7 | 91.2 / 46.1 | 50.0 | – ¹ | 283 / 1333 ² |
| Parakeet TDT-CTC 110M | en | 45.7 / 58.3 | 86.0 / 51.9 | 43.3 | 7.9 | 124 / 225 |
| Moonshine tiny | en | 45.0 / 50.0 | 86.0 / 41.6 | 38.3 | 13.7 | 52 / 105 |
| NeMo FastConformer en-de-es-fr (CTC) | en | 26.0 / 45.7 | 82.5 / 37.0 | 25.0 | 8.2 | 115 / 192 |
| Whisper small, told "ar" | ar | 33.0 / 57.7 | 64.9 / 56.0 | – | 9.7 | 1397 / 2058 |
| Omnilingual 300M | ar | 15.7 / 20.7 | 75.4 / 7.8 | – | 6.4 | 1737 / 3276 |
| Whisper base, told "ar" | ar | 11.0 / 24.7 | 42.1 / 20.6 | – | 20.2 | 479 / 789 |
| Dolphin base | ar | 8.7 / 25.3 | 29.8 / 24.3 | – | – | 240 / 590 |

¹ Apple returns only the last segment of a long recording, so its FLEURS WER (39 % en, 60 % de) says nothing about its free speech.

² Measured from the end of the audio to the final result, with the audio fed faster than spoken – not a latency at speaking pace. At speaking pace:
- Apple's final result came 41 ms (p50) and 57 ms (p95) after the end of the audio, which carries 400 ms of silence (en, 30 commands).
- Google's came 0.83 s (p50) and 1.13 s (p95) after the end of the speech (de, 20 commands): its own endpointer waits for silence. Shama closes the pipe at its own endpoint, which may shorten this.

What else the runs show:
- **Near misses, everyday sentences and FLEURS speech:** no recognizer turned any of them into a whole command (0 %, 0 per hour).
- **Noise:**
  - Whisper base heard words in all 6 noise files, Moonshine in 5, Apple de in 1.
  - Every other recognizer heard nothing.
- **Where they fail:**
  - Fixed commands are heard well: 77–98 % close.
  - Names and numbers are not. "Psalm" came out as "Xalm"; German "Vers" as "Fährst"; "Al-Baqarah" as "Albacara". Google drops the start of a command ("Sure Al-Ichlas Vers 88" → "88").
  - Biasing raised Apple by 5 points (en) and 7 (de, mostly fixed commands). On Google it did nothing.
  - So names rest on the matcher's tolerance – and on a second hearing by an embedded model where the system's is weak.
- **Arabic is the weak language:**
  - Dolphin guesses the language on short utterances and answers in Cyrillic, Korean or Chinese script.
  - Omnilingual is closer but confuses scripts too, and neither can be told the language.
  - Whisper can be told the language, but hallucinates in noise.

## Latency, memory, size

| | Load | Peak memory, commands | Library | Model (int8) |
| --- | --- | --- | --- | --- |
| Shenava Rizeh (fa) | 0.5 s | 260 MB | | 38 MB |
| Shenava Koochik (fa) | 0.7 s | 429 MB | | 132 MB |
| seda (tr) | 1.6 s | 384 MB | | 73 MB |
| NeMo FastConformer de | 0.6 s | 440 MB | | 136 MB |
| Parakeet 110M (en) | 0.6 s | 430 MB | | 132 MB |
| Moonshine tiny (en) | 0.3 s | 190 MB | | 44 MB |
| Dolphin base | 0.2 s | 459 MB | | 104 MB |
| Omnilingual 300M | 0.5 s | – | | 366 MB |
| Whisper base / small | 0.6 / 1.0 s | – | | 160 / 375 MB |
| sherpa-onnx 2.0.1, Android arm64 | | | 26.5 MB (ONNX Runtime 22.2 + C API 4.3) | |
| sherpa-onnx 2.0.1, macOS arm64, static | | | ~19 MB (the stripped bench binary) | |
| sherpa-onnx WASM (VAD + offline ASR build) | | | 11.7 MB; 3.2 gzip, 2.1 brotli | |
| Google's on-device packs | | | | en 62, de 58, tr 40 MB (the system's) |

**In the browser**: 50 commands each, one thread, the same hearings as natively.

| Model | Chromium: model loaded / decode p50 / p95 | Brave: model loaded / decode p50 / p95 |
| --- | --- | --- |
| Shenava Rizeh (fa) | 1.2 s / 143 / 238 ms | 1.3 s / 142 / 237 ms |
| NeMo FastConformer de | 1.8 s / 362 / 570 ms | 1.9 s / 348 / 531 ms |
| Parakeet 110M (en) | 1.4 s / 338 / 497 ms | 1.7 s / 324 / 482 ms |

- The runtime is ready 0.14–0.32 s after the page loads. "Model loaded" counts fetching it from localhost and creating the recognizer.
- The build reserves 537 MB of WASM memory, whatever the model.
- The prebuilt WASM build has no streaming recognizer, so seda (tr) didn't run in it. Moonshine wasn't tried in the browser.

**Echo:**
- *The setup:* the Mac's speaker reads a passage while its microphone listens; commands are played at the same level by another process.
- *Without echo cancellation:* no command spoken over the reading came out as a command (0 of 7 in de and in en). The reading alone triggered none.
- *With macOS voice processing:* everything was cancelled, the commands too. On the Mac it removes all the machine's own output, so a person in the room can't be simulated with one speaker.
- Interrupt words over the app's voice therefore need a phone. iOS's echo-cancelled input exists on 2024 iPhones and later.

## Licenses

| Component | License | Note |
| --- | --- | --- |
| sherpa-onnx | Apache-2.0 | |
| Shenava (fa) | Apache-2.0 | on the author's own repos (`Reza2kn/Shenava-*-sherpa-onnx`), relicensed in August 2026. k2-fsa's June export still says CC BY-NC 4.0: fetch from the author's |
| seda (tr) | Apache-2.0 | |
| NeMo models (de, en Parakeet) | CC BY 4.0 | credit them in the app |
| Moonshine tiny English | MIT | Moonshine's non-English models are non-commercial: out |
| Dolphin | Apache-2.0 | |
| Omnilingual | Apache-2.0 | |
| Whisper | MIT | |
| Vosk | – | out: no free iOS library, no small Arabic model |

## Decision (2026-11-05)

The system's recognizer where it hears the language on the device, always biased with the app's phrases; Shama's embedded model (sherpa-onnx) where it doesn't, on the web, and when an app asks for it. The models are catalogued in [engines/sherpa/models.json](../engines/sherpa/models.json), fetched and checked by `tools/models.mjs`.

| Language | iOS | Android | Web | Embedded model |
| --- | --- | --- | --- | --- |
| en | Apple | Google | embedded | `en-parakeet` (132 MB), `en-moonshine-tiny` (44 MB) where size counts |
| de | Apple | Google | embedded | `de-fastconformer` (136 MB) |
| tr | embedded, or Apple where a phone has tr on the device | Google | embedded | `tr-seda` (73 MB) |
| ar | Apple where a phone has ar on the device, else embedded | embedded | embedded | `ar-whisper-small` (375 MB): weak, for now |
| fa | embedded | embedded | embedded | `fa-rizeh` (38 MB) |

- **Persian:** k2-fsa's int8 export of Shenava Rizeh, measured here. The author's own repos are Apache-2.0; k2-fsa's export still says CC BY-NC 4.0.
- **Arabic stays open:** Whisper small hears 58 % of commands closely, at 375 MB and 1.4 s per command on the Mac. Next: NVIDIA's Arabic FastConformer, and commands recorded by people.
- **Credits:** the NeMo models (en, de) are CC BY 4.0, and an app using them credits them; each model's `shama-model.json` carries its license and credit.
- **Not yet:** a second hearing by the embedded model in stage 2, where the OS is weak on names; the web's embedded engine; a trimmed ONNX Runtime for Android's 26.5 MB per ABI.
- **The plan's targets aren't met on this synthetic corpus** (97 % for en and de, 95 % for tr, ar and fa). Fixed commands nearly reach them; names and numbers don't. Recheck with people's voices.

## Not measured here

- **Arabic:** NVIDIA's Arabic FastConformer, which needs a NeMo export, and a bigger Whisper.
- **Android:** embedded models on the emulator (`cargo ndk`).
- **Apple:** its custom language model – prepared over numbers up to 300, it hadn't finished after six minutes.
- **iOS:**
  - the simulator's speech recognition;
  - SpeechAnalyzer and DictationTranscriber, which need macOS 26;
  - the iOS slice sizes.
- **Phones:** real microphones and voices, accents, Bluetooth, echo cancellation, battery.
