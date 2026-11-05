#!/bin/sh
# Fetches sherpa-onnx's native libraries for the platforms named, checked against the digests
# GitHub publishes for release v2.0.1, into .cache/sherpa-archives – where the build looks.
#
#   sh engines/sherpa/fetch.sh [macos] [linux] [android] [ios]
set -eu
cd "$(dirname "$0")/../.."
dir=.cache/sherpa-archives
mkdir -p $dir
base=https://github.com/k2-fsa/sherpa-onnx/releases/download

fetch() { # tag, archive, sha256
  if [ -f "$dir/$2" ] && echo "$3  $dir/$2" | shasum -a 256 -c - > /dev/null 2>&1; then return; fi
  curl -fsSL -o "$dir/$2.part" "$base/$1/$2"
  echo "$3  $dir/$2.part" | shasum -a 256 -c - > /dev/null
  mv "$dir/$2.part" "$dir/$2"
  echo "fetched $2"
}

for platform in ${*:-macos}; do
  case $platform in
    macos) fetch v2.0.1 sherpa-onnx-v2.0.1-osx-arm64-static-lib.tar.bz2 d7a9b14f337958e7373c8c650f046df33d210bbaff2f33cb8322dda663ee5e1c ;;
    linux) fetch v2.0.1 sherpa-onnx-v2.0.1-linux-x64-static-lib.tar.bz2 55cfadf65ba50d0afc1a802b7a337942819e51c94a5b5a384def1978f7c70871 ;;
    android) fetch v2.0.1 sherpa-onnx-v2.0.1-android.tar.bz2 39003753ec293425ed56723ea9b972b98841a490af3311670c3060548d654330 ;;
    ios) fetch xcframework sherpa-onnx-v2.0.1-ios-shared-onnxruntime-static.xcframework.zip fc4c665e694322ced5393aafafaae6bb3e0a7449d98d5db60bc220ac7ac4cbc9 ;;
    *) echo "unknown platform: $platform" >&2; exit 1 ;;
  esac
done
