#!/bin/sh
# The rest of the Mac runs after the dedicated models: Dolphin for ar and fa, and Omnilingual and
# Whisper base as references for ar, fa and tr – without the noisy variants, to save time.
set -e
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"
summary=../../.cache/runs/summary-mac.jsonl
while pgrep -f "target/release/shama-bench fastconformer" >/dev/null; do sleep 5; done
./target/release/shama-bench dolphin-base fa "" 2 | tee -a "$summary"
./target/release/shama-bench dolphin-base ar "" 2 | tee -a "$summary"
for model in omni-300m whisper-base; do
  for lang in ar fa tr; do
    ./target/release/shama-bench "$model" "$lang" command,near,oov,fleurs,noise 2 | tee -a "$summary"
  done
done
