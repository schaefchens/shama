#!/bin/sh
# Runs the on-device recognizer over files/<lang> and joins its hearings with the corpus:
#   run.sh <lang> <locale> <out-name> [realtime true|false] [bias]
# Output: shama/.cache/runs/<out-name>/<lang>.jsonl in the scorer's format.
set -e
here=$(cd "$(dirname "$0")" && pwd)
root="$here/../.."
lang=$1; locale=$2; name=$3; realtime=${4:-false}; bias=$5
adb="$here/adb.sh"
"$adb" shell run-as de.schaefchens.shama.speechbench rm -f files/results.jsonl
if [ -n "$bias" ]; then
  "$adb" shell am start -S -n de.schaefchens.shama.speechbench/.BenchActivity --es cmd run --es lang "$locale" --es dir "files/$lang" --ez realtime "$realtime" --es bias "'$bias'" >/dev/null
else
  "$adb" shell am start -S -n de.schaefchens.shama.speechbench/.BenchActivity --es cmd run --es lang "$locale" --es dir "files/$lang" --ez realtime "$realtime" >/dev/null
fi
until "$adb" shell run-as de.schaefchens.shama.speechbench cat files/results.jsonl 2>/dev/null | grep -q '"event":"done"'; do sleep 10; done
mkdir -p "$root/.cache/runs/$name"
"$adb" shell run-as de.schaefchens.shama.speechbench cat files/results.jsonl > "$root/.cache/runs/$name/$lang.raw.jsonl"
node --input-type=module -e "
import fs from 'node:fs';
const [root, lang, name] = process.argv.slice(1);
const corpus = new Map(['manifest.jsonl','fleurs.jsonl','noise.jsonl'].flatMap(f => { try { return fs.readFileSync(root+'/.cache/corpus/'+lang+'/'+f,'utf8').trim().split('\n'); } catch { return []; } }).map(l => JSON.parse(l)).map(e => [e.id, e]));
const out = fs.readFileSync(root+'/.cache/runs/'+name+'/'+lang+'.raw.jsonl','utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.event === 'result').map(r => {
  const e = corpus.get(r.id);
  return JSON.stringify({ id: r.id, kind: e.kind, voice: e.voice, expected: e.expected, hypotheses: r.hypotheses.filter(h => h.text), latency_ms: r.latency_ms, audio_ms: e.ms, error: r.error });
});
fs.writeFileSync(root+'/.cache/runs/'+name+'/'+lang+'.jsonl', out.join('\n') + '\n');
console.log(name, lang, out.length, 'results');
" "$root" "$lang" "$name"
