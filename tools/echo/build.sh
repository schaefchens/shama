#!/bin/sh
# Builds ShamaEcho.app (ad-hoc signed). Run: open -W -n build/ShamaEcho.app --args <reading.wav> <schedule.json> <out.wav> <on|off> <seconds>
set -e
cd "$(dirname "$0")"
swift build -c release
app=build/ShamaEcho.app
rm -rf "$app" && mkdir -p "$app/Contents/MacOS"
cp .build/release/shama-echo "$app/Contents/MacOS/shama-echo"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>shama-echo</string>
  <key>CFBundleIdentifier</key><string>de.schaefchens.shama.echo</string>
  <key>CFBundleName</key><string>Shama Echo</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Measures how well short commands are heard while the Mac's speaker reads aloud, for the Shama library.</string>
</dict>
</plist>
PLIST
codesign -s - --force "$app" >/dev/null 2>&1
echo "$app"
