// shama-echo <reading.wav> <schedule.json> <out.wav> <on|off> <seconds>
//
// The reading plays through this engine's own output – the reference voice processing cancels –
// while the commands in schedule.json ([{"at": seconds, "file": path}]) play through afplay, a
// process of their own, as a person in the room would speak. The microphone, after voice
// processing or without it, is written to out.wav at the input's own rate.
import AVFoundation
import Foundation

let args = CommandLine.arguments
let (readingPath, schedulePath, outPath) = (args[1], args[2], args[3])
let processing = args[4] == "on"
let seconds = Double(args[5])!

func fail(_ message: String) -> Never {
    try? message.write(toFile: outPath + ".error", atomically: true, encoding: .utf8)
    exit(1)
}

let granted = await AVCaptureDevice.requestAccess(for: .audio)
if !granted { fail("microphone not allowed") }

let schedule = (try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: schedulePath))) as! [[String: Any]])
    .map { (at: $0["at"] as! Double, file: $0["file"] as! String) }
    .sorted { $0.at < $1.at }

let engine = AVAudioEngine()
// Touch the mixer and both I/O nodes first: enabling voice processing before the output node
// exists made the output fail to initialize (-10875).
_ = engine.mainMixerNode
let output = engine.outputNode
let input = engine.inputNode
do {
    try input.setVoiceProcessingEnabled(processing)
    try output.setVoiceProcessingEnabled(processing)
} catch {
    fail("voice processing: \(error)")
}
if processing {
    // The person's voice (afplay) must not be ducked: in a room it isn't.
    input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
}
let player = AVAudioPlayerNode()
engine.attach(player)
let reading = try! AVAudioFile(forReading: URL(fileURLWithPath: readingPath))
engine.connect(player, to: engine.mainMixerNode, format: reading.processingFormat)
let format = input.outputFormat(forBus: 0)
let out = try! AVAudioFile(forWriting: URL(fileURLWithPath: outPath), settings: format.settings)
input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
    try? out.write(from: buffer)
}
do {
    try engine.start()
} catch {
    fail("engine: \(error)")
}
player.scheduleFile(reading, at: nil)
player.play()
let start = Date()
for item in schedule {
    let wait = item.at - Date().timeIntervalSince(start)
    if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1e9)) }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/afplay")
    process.arguments = [item.file]
    try? process.run()
}
let rest = seconds - Date().timeIntervalSince(start)
if rest > 0 { try? await Task.sleep(nanoseconds: UInt64(rest * 1e9)) }
player.stop()
engine.stop()
input.removeTap(onBus: 0)
try? "\(format.sampleRate) \(format.channelCount)".write(toFile: outPath + ".format", atomically: true, encoding: .utf8)
