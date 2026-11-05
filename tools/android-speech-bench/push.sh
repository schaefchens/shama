#!/bin/sh
# Converts a language's corpus entries to raw 16 kHz PCM and copies them into the bench app's
# files/<lang>/ on shama_play:  push.sh <lang> command=300,near=30,oov=30,fleurs=30,noise=6
set -e
here=$(cd "$(dirname "$0")" && pwd)
root="$here/../.."
lang=$1; spec=$2
out="$root/.cache/android/pcm/$lang"
rm -rf "$out" && mkdir -p "$out"
node --input-type=module -e "
import fs from 'node:fs';
const [root, lang, spec] = process.argv.slice(1);
const lines = ['manifest.jsonl','fleurs.jsonl','noise.jsonl'].flatMap(f => { try { return fs.readFileSync(root+'/.cache/corpus/'+lang+'/'+f,'utf8').trim().split('\n'); } catch { return []; } }).map(l => JSON.parse(l));
for (const part of spec.split(',')) { const [kind, count] = part.split('='); for (const e of lines.filter(e => e.kind === kind).slice(0, Number(count))) console.log(e.id + ' ' + e.file); }
" "$root" "$lang" "$spec" > "$out/list.txt"
while read -r id file; do
  ffmpeg -v error -y -i "$root/$file" -ac 1 -ar 16000 -f s16le "$out/$id.pcm"
done < "$out/list.txt"
"$here/adb.sh" shell run-as de.schaefchens.shama.speechbench sh -c "'rm -rf files/$lang && mkdir -p files/$lang'"
# One tar stream instead of a call per file.
(cd "$out" && tar cf - ./*.pcm) | "$here/adb.sh" exec-in run-as de.schaefchens.shama.speechbench sh -c "cd files/$lang && tar xf -"
echo "$lang: $(ls "$out"/*.pcm | wc -l | tr -d ' ') files pushed"
