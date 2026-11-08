#!/bin/sh
# CI's end-to-end run on an Android emulator: installs the demo's release build and runs the device
# test. Where it fails, tools/e2e-why.mjs says why in the job's annotations, which anyone can read.
#
#   sh tools/ci-android.sh <emulator serial>
set -u
cd "$(dirname "$0")/.."
device=${1:-emulator-5554}
out=${RUNNER_TEMP:-/tmp}
adb -s "$device" install -r examples/react-native/android/app/build/outputs/apk/release/app-release.apk || exit 1
# A slow emulator's "isn't responding" dialogs would cover the app: none are shown.
adb -s "$device" shell settings put global hide_error_dialogs 1
# The device's log all along: what it said last, should it go away.
adb -s "$device" logcat -v time > "$out/logcat.txt" 2>&1 &
logcat=$!
sh tools/e2e_react_native.sh android "$device" > "$out/e2e.txt" 2>&1
status=$?
kill $logcat 2> /dev/null
cat "$out/e2e.txt"
if [ $status != 0 ]; then
  # Where the device went: its state, how long it has run, whether Android's system restarted or
  # crashed – and the host's memory and its killer.
  {
    echo "device: $(adb -s "$device" get-state 2>&1)"
    echo "uptime: $(adb -s "$device" shell uptime 2>&1)"
    free -m 2> /dev/null | sed -n 2p
    sudo -n dmesg 2> /dev/null | grep -iE "out of memory|killed process" | tail -3
    adb -s "$device" shell "logcat -b events -d | grep -E 'boot_progress_start|am_crash|watchdog|am_anr'" 2>&1 | tail -8
    adb -s "$device" shell logcat -b crash -d 2>&1 | grep -vE "^-+ beginning" | tail -12
  } > "$out/host.txt"
  node tools/e2e-why.mjs "$out/e2e.txt" "" "$out/host.txt" "$out/logcat.txt"
fi
exit $status
