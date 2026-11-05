#!/bin/sh
# Apple's on-device recognizer over the corpus for every language this Mac recognizes on the
# device: unbiased, with contextualStrings, with a custom language model – fed as fast as it
# goes; then 30 commands at speaking pace for the latency.
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
# Files padded as Shama's endpointer pads speech (tools/corpus/pad.mjs); runs are written beside the others.
corpus="$root/.cache/padded"
app="$here/build/ShamaAppleSpeech.app"
for pair in en:en-US de:de-DE tr:tr-TR ar:ar-SA; do
  lang=${pair%%:*}; locale=${pair#*:}
  # The custom language model is left out: with the templates expanded over numbers up to 300 its
  # preparation hadn't finished after six minutes (2026-11-05).
  for bias in none context; do
    # A run already complete (or one that found no on-device recognizer) isn't repeated.
    [ -s "$root/.cache/runs/apple-$bias/$lang.jsonl" ] && [ "$(wc -l < "$root/.cache/runs/apple-$bias/$lang.jsonl")" -ge 886 ] && continue
    mkdir -p "$root/.cache/runs/apple-$bias"
    open -W -n "$app" --args run "$corpus" "$lang" "$locale" "$root/.cache/runs/apple-$bias/$lang.jsonl" "$bias" fast command,near,oov,fleurs,noise,variant
    echo "apple-$bias $lang: $(wc -l < "$root/.cache/runs/apple-$bias/$lang.jsonl") lines"
  done
  mkdir -p "$root/.cache/runs/apple-realtime"
  open -W -n "$app" --args run "$corpus" "$lang" "$locale" "$root/.cache/runs/apple-realtime/$lang.jsonl" none realtime command 30
done
