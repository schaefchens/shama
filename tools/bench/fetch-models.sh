#!/bin/sh
# Fetches the embedded models measured for docs/engines.md into shama/.cache/models: sherpa-onnx's
# release archives listed in models.txt (name, size, SHA-256 where GitHub gives one – recorded on
# the first download where it doesn't), and seda for Turkish from Hugging Face.
set -e
here=$(cd "$(dirname "$0")" && pwd)
models="$here/../../.cache/models"
mkdir -p "$models"
cd "$models"
while read -r name size sum; do
  dir=${name%.tar.bz2}
  [ -d "$dir" ] && continue
  curl -sSL -o "$name" "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$name"
  [ "$(stat -f %z "$name")" = "$size" ] || { echo "size differs: $name" >&2; exit 1; }
  if [ "$sum" = none ]; then shasum -a 256 "$name"; else echo "$sum  $name" | shasum -a 256 -c -; fi
  tar xjf "$name" && rm "$name"
done < "$here/models.txt"
# seda-v0.1 (Turkish streaming zipformer transducer, Apache-2.0), at the commit measured.
if [ ! -d seda-v0.1 ]; then
  mkdir seda-v0.1
  for file in encoder.int8.onnx decoder.onnx joiner.int8.onnx tokens.txt README.md; do
    curl -sSL -o "seda-v0.1/$file" "https://huggingface.co/atasoglu/seda-v0.1/resolve/main/$file"
  done
  shasum -a 256 seda-v0.1/*.onnx
fi
du -sh ./*
