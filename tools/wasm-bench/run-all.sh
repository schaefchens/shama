#!/bin/sh
# The browser runs for docs/engines.md: each language's embedded candidate as WebAssembly, in
# Playwright's Chromium and in Brave, 50 commands each.
set -e
here=$(cd "$(dirname "$0")" && pwd)
cd "$here/../.."
rm -f .cache/runs/summary-wasm.jsonl
for pair in fa-rizeh:fa tr-seda:tr de-nemo-transducer:de en-moonshine-tiny:en; do
  for browser in chromium brave; do
    node tools/wasm-bench/bench.mjs --browser "$browser" --model "${pair%%:*}" --lang "${pair#*:}" --count 50
  done
done
