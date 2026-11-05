// swift-tools-version:5.10
// Plays a reading through the Mac's speaker while recording its microphone – with Apple's voice
// processing (echo cancellation) on or off – and plays "user" commands from another process at
// set times. Built into an app bundle by build.sh for the microphone permission.
import PackageDescription

let package = Package(
    name: "shama-echo",
    platforms: [.macOS(.v14)],
    targets: [.executableTarget(name: "shama-echo")]
)
