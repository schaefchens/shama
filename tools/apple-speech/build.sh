#!/bin/sh
# Builds the measuring CLI and wraps it as ShamaAppleSpeech.app (ad-hoc signed), so that macOS
# attributes the speech-recognition and microphone permissions to it. Run it with
#   open -W -n ShamaAppleSpeech.app --args <command> ...
# – its output goes to the files the command names, not to the terminal.
set -e
cd "$(dirname "$0")"
swift build -c release
app=build/ShamaAppleSpeech.app
rm -rf "$app" && mkdir -p "$app/Contents/MacOS"
cp .build/release/apple-speech "$app/Contents/MacOS/apple-speech"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>apple-speech</string>
  <key>CFBundleIdentifier</key><string>de.schaefchens.shama.apple-speech</string>
  <key>CFBundleName</key><string>Shama Apple Speech</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.0</string>
  <key>LSUIElement</key><true/>
  <key>NSSpeechRecognitionUsageDescription</key><string>Measures on-device speech recognition for the Shama library over recorded test commands.</string>
  <key>NSMicrophoneUsageDescription</key><string>Measures how well short commands are heard while the Mac's speaker reads aloud.</string>
</dict>
</plist>
PLIST
codesign -s - --force "$app" >/dev/null 2>&1
echo "$app"
