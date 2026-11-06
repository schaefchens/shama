#!/bin/sh
# Frees disk space: removes what builds and tests left behind – all of it made again by the build
# scripts, the tests and the tools that made it. Only paths git ignores are touched in the
# repository; outside it, only Xcode's build folder for the demo's workspace.
#
#   sh tools/clean.sh               builds and test leftovers
#   sh tools/clean.sh --downloads   also the models and libraries fetched – checked again when fetched anew
#   sh tools/clean.sh --all         also the downloads and node_modules
#   sh tools/clean.sh -n [...]      lists what would go, with sizes, and removes nothing
#
# Kept always: the measuring corpus (.cache/corpus – voices paid for), the echo recordings and the
# measuring runs (.cache/echo, .cache/runs), and the debug keystore.
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)

dry=0 downloads=0 deps=0
for arg in "$@"; do
  case $arg in
    -n | --dry-run) dry=1 ;;
    --downloads) downloads=1 ;;
    --all) downloads=1 deps=1 ;;
    *) echo "usage: sh tools/clean.sh [-n] [--downloads | --all]" >&2; exit 1 ;;
  esac
done

# Builds: the Rust workspace and the tools', the core for the platforms and its bindings, the
# packages' and the examples' builds, and the demo's native projects, which Expo's prebuild makes.
builds='target tools/*/target tools/*/.build tools/*/build
bindings/*/dist bindings/web/src/generated
bindings/react-native/ios/ShamaCore.xcframework bindings/react-native/ios/SherpaOnnxC.xcframework
bindings/react-native/ios/generated bindings/react-native/android/src/main/jniLibs
bindings/react-native/android/src/main/java/de/schaefchens/shama/core
bindings/react-native/android/build bindings/react-native/android/.gradle bindings/react-native/android/.cxx
examples/react-native/ios examples/react-native/android examples/react-native/.expo examples/web/dist'

# What tests and measuring left: fixture recordings, browser profiles, padded corpus copies, logs.
leftovers='examples/*/public/fixtures examples/*/assets/fixtures examples/web/test-results examples/web/playwright-report
.cache/fixtures .cache/fixtures-check .cache/check-models .cache/padded .cache/android
.cache/wasm/profile-* .cache/generated-* .cache/ios-simulator .cache/*.log .cache/*.png'

fetched='.cache/models .cache/device-models .cache/hosana-models .cache/sherpa-archives .cache/wasm/sherpa .cache/meta'

modules='node_modules bindings/*/node_modules examples/*/node_modules'

patterns="$builds $leftovers"
[ $downloads = 1 ] && patterns="$patterns $fetched"
[ $deps = 1 ] && patterns="$patterns $modules"

total=0
remove() { # path, shown as
  kb=$(du -sk "$1" 2> /dev/null | cut -f1)
  total=$((total + ${kb:-0}))
  printf '%9.1f MB  %s\n' "$(echo "${kb:-0} / 1024" | bc -l)" "$2"
  [ $dry = 1 ] || rm -rf "$1"
}

for pattern in $patterns; do
  for path in $pattern; do
    [ -e "$path" ] || continue
    # Never what git keeps, nor what it would: only what it ignores.
    if ! git check-ignore -q "$path"; then
      echo "kept, not ignored by git: $path" >&2
      continue
    fi
    remove "$path" "$path"
  done
done

# Xcode's build folder for the demo – the one whose workspace is in this repository.
if [ "$(uname)" = Darwin ]; then
  for folder in "$HOME"/Library/Developer/Xcode/DerivedData/*/; do
    [ -f "$folder/info.plist" ] || continue
    workspace=$(/usr/libexec/PlistBuddy -c 'Print :WorkspacePath' "$folder/info.plist" 2> /dev/null || true)
    case $workspace in "$root"/*) remove "${folder%/}" "${folder%/} (Xcode, ${workspace#"$root"/})" ;; esac
  done
fi

verb=$([ $dry = 1 ] && echo "would free" || echo "freed")
printf '%s %.1f GB\n' "$verb" "$(echo "$total / 1048576" | bc -l)"
