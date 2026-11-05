#!/bin/sh
# Arabic's gap: Whisper base told the language, and Omnilingual over all commands and FLEURS.
set -e
cd "$(dirname "$0")"
summary=../../.cache/runs/summary-mac.jsonl
./target/release/shama-bench whisper-base ar command,near,oov,fleurs,noise 2 | tee -a "$summary"
./target/release/shama-bench omni-300m ar command,fleurs 2 | tee -a "$summary"
