// swift-tools-version:5.10
// Measures Apple's on-device speech recognition on the Mac over Shama's corpus. Built into an app
// bundle by build.sh, so macOS asks for (and remembers) the speech-recognition permission.
import PackageDescription

let package = Package(
    name: "apple-speech",
    platforms: [.macOS(.v14)],
    targets: [.executableTarget(name: "apple-speech")]
)
