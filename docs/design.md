# Design

The decisions behind Shama, and why (November 2026).

## Stages

Every utterance goes through up to three stages, each only where the one before couldn't settle it – never all at once:

1. **Deterministic**, in the core: the app's phrases, matched whole – exactly, or with one edit in a phrase of 12 letters or more – the tools of the context in front first. The app's state fills what goes unsaid where what was said agrees with it.
2. **Local best effort**, on the device: fillers dropped, more edits, Arabic proclitics and Turkish suffixes allowed; then the app's own resolvers, its search say. A phrase found inside longer speech is asked back, never acted on.
3. **AI**: a language model gets the words heard, framed as data, and only the tools the moment offers – never one marked `ai: false`. One request per utterance; every call it returns is checked in the core.

- Commands are fast, private and predictable; a model is slower, may cost, and can be wrong. It comes last, and only where it is allowed.
- **Consequential tools are confirmed**, from any stage. A confirmation is answered by the user – a yes, a no, a button – never by an AI.
- One phrase meaning two calls is an error when the vocabulary is compiled, not a guess at run time.

## Offline and online

The app sets the mode, per request if it likes.

- **Offline:** recognition on the device, and the system's own language model where there is one (Apple Foundation Models, Gemini Nano, Chrome's built-in model) and it speaks the language. Otherwise Shama stops after stage 2 and says why (`offline`).
- **Online:** an external AI may follow the device's. Only text goes out – the words heard, the app's brief and state, the tools' schemas – never audio.
- **LIVE hears more than what is said to the app**: an external AI hears LIVE speech only where the app allows it, and may answer that something wasn't addressed to the app.

## Recognizers

- **The system's, held on the device** – Apple's with `requiresOnDeviceRecognition`, Android's on-device recognizer – biased with the app's phrases and names. Never a system recognizer that may stream to a server.
- **An embedded engine** where the system has none: Persian, phones without Google's services, the web. Which serves which language follows the measurement in [engines.md](engines.md).
- The system's recognizers run on the device but are the system's code; an app that wants the audio to stay in its own process asks for the embedded engine.
- **A fixture recognizer** reads what a test recording says from the file itself: the whole pipeline, every platform, without models.

## Push-to-talk and LIVE

- **Push-to-talk:** Shama tells the app first, and waits up to a second for it to pause its own voice; then it opens the microphone. One utterance, ended by a 0.9 s pause or by letting go.
- **LIVE**, switched on: utterance after utterance, Shama answering aloud. While the app speaks, only its interrupt tools count, matched exactly, on echo-cancelled input; where the platform cancels no echo – iOS before 2024 iPhones, Android without the effect – Shama pauses while the app speaks, as the app may also choose. A session ends on the toggle, on "stop listening", after a quiet time in which no voice spoke, or when the app leaves the screen. No wake word.
- Speech starts after 60 ms of loud sound; under 120 ms it is no speech, and no recognizer hears it – a recognizer given a click may hear words in it.

## What stays where

- **Audio** never reaches JavaScript on native platforms, nor the page's main thread on the web; it is never written to disk or sent away, and buffers are zeroed after use.
- **Debugging** is the app's choice, off by default: diagnostics tell numbers, never words. Kept audio – the last 8 utterances, in memory, zeroed when given up – is played natively, and written to a file only when the app saves one: the app's documents on iOS, its external files on Android, a download in a browser, whose page then holds it.
- **What was heard** stays in native code or the worker. JavaScript gets the words only for a stage there – the app's resolvers, an external AI – or when the app asks for them to debug. The system's language model gets them natively; in a browser they pass through the page.
- **Nothing is logged** of what was said; results carry timings and the stages' trail.

## Defaults

- End pause 0.9 s (LIVE 0.7 s), at most 15 s an utterance, 6 s without speech is nothing heard.
- A question stays open 30 s. An AI gets 10 s, at most 3 calls, a reply of at most 300 characters.
- LIVE's quiet time: 2 minutes.

## Open

- A native speaker's review of the Turkish, Arabic and Persian phrases and built-in words.
- Real phones: microphones, distance, noise, Bluetooth, echo cancellation – there is no phone here.
