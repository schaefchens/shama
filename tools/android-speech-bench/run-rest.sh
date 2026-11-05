#!/bin/sh
# The Android runs left after German's unbiased one: English and Turkish unbiased (a smaller set),
# all three biased with the corpus' names and commands, and German at speaking pace for latency.
set -e
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"
bias() { node -e "const s=require('../corpus/commands/$1.json'); console.log([...s.books, ...s.surahs, ...s.commands].join('|'))"; }
for pair in en:en-US tr:tr-TR; do
  lang=${pair%%:*}; locale=${pair#*:}
  ./push.sh "$lang" command=100,near=20,oov=20,fleurs=10,noise=6
  ./run.sh "$lang" "$locale" android-os false
done
for pair in de:de-DE en:en-US tr:tr-TR; do
  lang=${pair%%:*}; locale=${pair#*:}
  ./push.sh "$lang" command=100
  ./run.sh "$lang" "$locale" android-os-bias false "$(bias "$lang")"
done
./push.sh de command=20
./run.sh de de-DE android-os-realtime true
