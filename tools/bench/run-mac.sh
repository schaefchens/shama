#!/bin/sh
# Runs every embedded candidate over its languages' whole corpus on this Mac, one after another
# (so their timings don't compete), two threads each, as a phone would give it.
set -e
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"
summary=../../.cache/runs/summary-mac.jsonl
mkdir -p ../../.cache/runs
while read -r model langs; do
  for lang in $(echo "$langs" | tr ',' ' '); do
    ./target/release/shama-bench "$model" "$lang" "" 2 | tee -a "$summary"
  done
done <<LIST
fa-rizeh fa
fa-pizeh fa
fa-koochik fa
en-moonshine-tiny en
en-parakeet-110m en
tr-seda tr
de-nemo-transducer de
fastconformer-en-de-es-fr en,de
dolphin-base fa,ar
omni-300m fa,ar,tr,de,en
whisper-base fa,ar,tr,de,en
LIST
