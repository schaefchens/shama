#!/bin/sh
# Runs the React Native example's self-test, kept audio and diagnostics on a simulator or emulator
# where the example is installed: puts the embedded model the self-test uses where the example
# looks for it, then runs the Maestro flows. Needs Maestro (and JAVA_HOME for it) and adb or Xcode.
#
#   sh tools/e2e_react_native.sh ios <simulator UDID>
#   sh tools/e2e_react_native.sh android <emulator serial>
set -eu
cd "$(dirname "$0")/.."
platform=$1
device=$2
app=de.schaefchens.shama.example
models=.cache/device-models
node tools/models.mjs $models tr-seda > /dev/null

case $platform in
  ios)
    data=$(xcrun simctl get_app_container "$device" $app data)
    mkdir -p "$data/Documents/shama-models"
    cp -R $models/ "$data/Documents/shama-models/"
    ;;
  android)
    adb -s "$device" push $models/. /sdcard/Android/data/$app/files/shama-models/ > /dev/null
    # Folders adb makes there are the shell's: the app may read them only when they are opened up.
    # Once the app has run they are its own, and not adb's to change – nor need they be.
    adb -s "$device" shell "chmod -R o+rX /sdcard/Android/data/$app 2> /dev/null || true"
    # The microphone allowed beforehand: no dialog in the way of the flows.
    adb -s "$device" shell pm grant $app android.permission.RECORD_AUDIO
    ;;
  *) echo "usage: sh tools/e2e_react_native.sh ios|android <device>" >&2; exit 1 ;;
esac
# An emulator under load may drop off adb for a moment: before each flow, wait until it is back.
reachable() {
  [ $platform = android ] || return 0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    [ "$(adb -s "$device" get-state 2> /dev/null)" = device ] && return 0
    adb reconnect offline > /dev/null 2>&1
    sleep 2
  done
  return 1
}

failed=0
for flow in self-test recordings diagnostics; do
  if reachable && maestro --device "$device" test examples/react-native/e2e/$flow.yaml; then
    echo "[Passed] $flow"
  else
    echo "[Failed] $flow"
    failed=1
  fi
done
exit $failed
