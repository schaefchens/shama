# Shama

Voice commands and a voice assistant for apps – on the device first.

Your app tells Shama what it can do: its **tools** – "open a book at a chapter", "next", "stop" – and the phrases people say for them in each language. Shama listens, recognizes the words on the device and settles them in stages, each only where the one before couldn't:

1. **Deterministic:** the app's phrases, names and numbers, matched whole – "read Moby Dick chapter forty-two".
2. **Best effort on the device:** looser matching, a second hearing, the app's own resolvers.
3. **AI:** a language model gets the words heard and only the tools the moment needs – the device's own model, or, online, a provider the app chooses.

The app gets calls to its tools, never audio. People talk by a button (push-to-talk) or in **LIVE**, a conversation that goes on – Shama answering aloud – until they end it.

Shama will run inside apps on iOS and Android (React Native) and in the browser, with one TypeScript API. It is being built (November 2026) and not on npm yet.

### Made with AI

Shama is written with an AI model – Anthropic's Claude, through Claude Code – under its maintainer's direction: the code, its tests and these documents.

## License

Apache 2.0 – see [LICENSE](LICENSE).
