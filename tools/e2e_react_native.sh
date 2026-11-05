#!/bin/sh
# Runs the React Native example's self-test on a simulator or emulator where the example is
# installed: puts the embedded model the self-test uses where the example looks for it, then
# runs the Maestro flow. Needs Maestro (and JAVA_HOME for it) and adb or Xcode.
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
    adb -s "$device" shell chmod -R o+rX /sdcard/Android/data/$app
    ;;
  *) echo "usage: sh tools/e2e_react_native.sh ios|android <device>" >&2; exit 1 ;;
esac
maestro --device "$device" test examples/react-native/e2e/self-test.yaml
