#!/bin/sh
# Builds Shama's core for iOS – a dynamic framework, so it sits next to other Rust libraries in
# an app – and for Android, and generates its Swift and Kotlin bindings, which only the native
# module calls; and puts sherpa-onnx's libraries beside it, the embedded recognizer's runtime.
# Needs rustup with the iOS and Android targets, cargo-ndk, Xcode and ANDROID_HOME; Android builds
# on Linux too. ANDROID_ABIS chooses Android's ABIs: "arm64-v8a x86_64" by default.
#
#   sh build.sh [ios] [android]
set -e

# rustup's toolchain first: a Homebrew Rust earlier in PATH has no iOS or Android targets.
export PATH="$HOME/.cargo/bin:$PATH"
here=$(cd "$(dirname "$0")" && pwd)
cd "$here/../.."
name=shama_ffi
# CocoaPods links a framework by its xcframework's name.
framework_name=ShamaCore
platforms=${*:-ios android}
abis=${ANDROID_ABIS:-arm64-v8a x86_64}
archives=.cache/sherpa-archives
# The bindings are generated from a build for this machine, which links sherpa-onnx statically.
case $(uname) in
  Darwin) host=macos library=target/debug/lib$name.dylib ;;
  *) host=linux library=target/debug/lib$name.so ;;
esac
sh engines/sherpa/fetch.sh $host $platforms

cargo build -q -p shama-ffi
cargo run -q -p uniffi-bindgen -- generate --library "$library" --language swift --out-dir "$here/ios/generated"
cargo run -q -p uniffi-bindgen -- generate --library "$library" --language kotlin --no-format --out-dir "$here/android/src/main/java"

case " $platforms " in *" ios "*)
  rm -rf target/react-native "$here/ios/ShamaCore.xcframework"
  frameworks=""
  for target in aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim; do
    IPHONEOS_DEPLOYMENT_TARGET=16.4 cargo build -q -p shama-ffi --release --target $target
  done
  # The device's framework, and the simulator's for both kinds of Mac (a Release build wants both).
  for target in aarch64-apple-ios aarch64-apple-ios-sim; do
    framework=target/react-native/$target/$framework_name.framework
    mkdir -p $framework
    if [ $target = aarch64-apple-ios ]; then
      cp target/$target/release/lib$name.dylib $framework/$framework_name
    else
      lipo -create target/$target/release/lib$name.dylib target/x86_64-apple-ios/release/lib$name.dylib \
        -output $framework/$framework_name
    fi
    install_name_tool -id @rpath/$framework_name.framework/$framework_name $framework/$framework_name
    platform=$([ $target = aarch64-apple-ios ] && echo iPhoneOS || echo iPhoneSimulator)
    cat > $framework/Info.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>$framework_name</string>
  <key>CFBundleIdentifier</key><string>de.schaefchens.shama.core</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$framework_name</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>0.0.0</string>
  <key>CFBundleSupportedPlatforms</key><array><string>$platform</string></array>
  <key>CFBundleVersion</key><string>1</string>
  <key>MinimumOSVersion</key><string>16.4</string>
</dict>
</plist>
PLIST
    frameworks="$frameworks -framework $framework"
  done
  xcodebuild -create-xcframework $frameworks -output "$here/ios/$framework_name.xcframework" > /dev/null
  rm -rf "$here/ios/SherpaOnnxC.xcframework"
  unzip -q $archives/sherpa-onnx-v2.0.1-ios-shared-onnxruntime-static.xcframework.zip 'SherpaOnnxC.xcframework/*' -d "$here/ios"
  echo "iOS: $here/ios/ShamaCore.xcframework, SherpaOnnxC.xcframework"
esac

case " $platforms " in *" android "*)
  targets=""
  for abi in $abis; do targets="$targets -t $abi"; done
  cargo ndk $targets -P 24 -o "$here/android/src/main/jniLibs" build -q -p shama-ffi --release
  for abi in $abis; do
    tar xjf $archives/sherpa-onnx-v2.0.1-android.tar.bz2 -C "$here/android/src/main" \
      ./jniLibs/$abi/libsherpa-onnx-c-api.so ./jniLibs/$abi/libonnxruntime.so
  done
  echo "Android: $here/android/src/main/jniLibs"
esac
