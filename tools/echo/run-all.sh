#!/bin/sh
# The four echo sessions: German and English readings, voice processing off and on.
set -e
here=$(cd "$(dirname "$0")" && pwd)
echo="$here/../../.cache/echo"
echo=$(cd "$echo" && pwd)
for lang in de en; do
  for vp in off on; do
    out="$echo/$lang-vp-$vp.wav"
    [ -f "$out.format" ] && continue
    rm -f "$out" "$out.error" "$out.format"
    open -W -n "$here/build/ShamaEcho.app" --args "$echo/reading-$lang.wav" "$echo/schedule-$lang.json" "$out" "$vp" 60
    [ -f "$out.format" ] || { cat "$out.error"; exit 1; }
    echo "$lang $vp: $(cat "$out.format")"
  done
done
