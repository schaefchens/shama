// The self-test's recordings, made by tools/fixtures.mjs (`npm run fixtures`, run before every
// start) and bundled with the app.
export const fixtures: Record<string, number> = {
  'en-open.wav': require('../assets/fixtures/en-open.wav'),
  'de-open.wav': require('../assets/fixtures/de-open.wav'),
  'tr-open.wav': require('../assets/fixtures/tr-open.wav'),
  'ar-open.wav': require('../assets/fixtures/ar-open.wav'),
  'fa-open.wav': require('../assets/fixtures/fa-open.wav'),
  'en-os.wav': require('../assets/fixtures/en-os.wav'),
  'de-os.wav': require('../assets/fixtures/de-os.wav'),
  'tr-os.wav': require('../assets/fixtures/tr-os.wav'),
  'tr-embedded.wav': require('../assets/fixtures/tr-embedded.wav'),
  'en-nothing.wav': require('../assets/fixtures/en-nothing.wav'),
  'en-ai.wav': require('../assets/fixtures/en-ai.wav'),
  'en-live.wav': require('../assets/fixtures/en-live.wav'),
};
