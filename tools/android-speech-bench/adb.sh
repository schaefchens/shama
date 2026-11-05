#!/bin/sh
# adb for shama_play only: refuses to run unless emulator-5592 really is the shama_play AVD –
# other sessions' emulators have taken that port before.
adb="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
name=$("$adb" -s emulator-5592 emu avd name 2>/dev/null | head -1 | tr -d '\r')
[ "$name" = shama_play ] || { echo "emulator-5592 is '$name', not shama_play" >&2; exit 1; }
exec "$adb" -s emulator-5592 "$@"
