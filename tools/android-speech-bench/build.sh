#!/bin/sh
# Builds the speech bench APK with the SDK's own tools – javac, d8, aapt2, zipalign, apksigner –
# as this Mac has no Gradle. Needs JDK 21 (Homebrew's openjdk@21) and build-tools 36.
set -e
cd "$(dirname "$0")"
sdk=${ANDROID_HOME:-$HOME/Library/Android/sdk}
tools=$sdk/build-tools/36.0.0
jar=$sdk/platforms/android-36/android.jar
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}
export PATH="$JAVA_HOME/bin:$PATH"
rm -rf build && mkdir -p build/classes build/dex
javac -nowarn --release 17 -classpath "$jar" -d build/classes $(find src -name '*.java') 2>&1 | grep -v 'release 17' || true
"$tools/d8" --release --min-api 33 --lib "$jar" --output build/dex $(find build/classes -name '*.class')
"$tools/aapt2" link -o build/unsigned.apk -I "$jar" --manifest AndroidManifest.xml
(cd build/dex && zip -q ../unsigned.apk classes.dex)
"$tools/zipalign" -f 4 build/unsigned.apk build/aligned.apk
keystore=../../.cache/android-debug.keystore
[ -f "$keystore" ] || keytool -genkeypair -keystore "$keystore" -storepass android -keypass android -alias debug \
  -dname "CN=Shama bench" -keyalg RSA -keysize 2048 -validity 3650 >/dev/null 2>&1
"$tools/apksigner" sign --ks "$keystore" --ks-pass pass:android --key-pass pass:android --out build/speech-bench.apk build/aligned.apk
echo build/speech-bench.apk
