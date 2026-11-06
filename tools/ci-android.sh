#!/bin/sh
# CI's end-to-end run on an Android emulator: installs the demo's release build and runs the device
# test. Where it fails, tools/e2e-why.mjs says why in the job's annotations, which anyone can read.
#
#   sh tools/ci-android.sh <emulator serial>
set -u
cd "$(dirname "$0")/.."
device=${1:-emulator-5554}
log=${RUNNER_TEMP:-/tmp}/e2e.txt
adb -s "$device" install -r examples/react-native/android/app/build/outputs/apk/release/app-release.apk || exit 1
sh tools/e2e_react_native.sh android "$device" > "$log" 2>&1
status=$?
cat "$log"
[ $status = 0 ] || node tools/e2e-why.mjs "$log"
exit $status
