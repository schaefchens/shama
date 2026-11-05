# Test fixtures

- `vocabulary.json` – the examples' vocabulary: a neutral audiobook reader in English, German, Turkish, Arabic and Persian. Written for Shama; the book titles are names of public-domain works.
- `heard/<language>.tsv` – what a recognizer might hear, and what it must settle into: stage (1, 2, or `-` for nothing), the app's contexts, whether the app is speaking, the words heard, the outcome. Written for Shama. The Turkish, Arabic and Persian phrasings still need a native speaker's review.

The audio in the tests is synthesized in the tests themselves; no recordings are kept here.
