#!/bin/sh
# Every Android on-device run for docs/engines.md, one after another: de, en and tr (the
# languages Google's on-device recognizer offers here) – unbiased, biased with the corpus' names
# and commands, and 20 commands at speaking pace for the latency.
set -e
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"
for pair in de:de-DE en:en-US tr:tr-TR; do
  lang=${pair%%:*}; locale=${pair#*:}
  bias=$(node -e "const s=require('../corpus/commands/$lang.json'); console.log([...s.books, ...s.surahs, ...s.commands].join('|'))")
  ./push.sh "$lang" command=150,near=30,oov=30,fleurs=20,noise=6
  ./run.sh "$lang" "$locale" android-os false
  ./push.sh "$lang" command=150
  ./run.sh "$lang" "$locale" android-os-bias false "$bias"
  ./push.sh "$lang" command=20
  ./run.sh "$lang" "$locale" android-os-realtime true
done
