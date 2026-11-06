import AVFAudio
import Foundation

/// The microphone, through AVAudioEngine: the session set up for listening and handed back as it
/// was found; audio at the hardware's rate, mixed to one channel.
///
/// Push-to-talk takes the session for itself, with as little processing as Apple's recognizers
/// want (`.measurement`). LIVE shares it – the app reads aloud meanwhile – and asks for the app's
/// own sound taken out of the microphone, which iOS 18.2 offers on 2024 iPhones and later.
final class Capture {
  private let engine = AVAudioEngine()
  private let live: Bool
  private let onAudio: ([Float]) -> Void
  private var saved: (category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions)?
  private var observers: [NSObjectProtocol] = []
  var onInterrupted: ((String) -> Void)?
  /// The route changed: another microphone, headphones plugged in or out.
  var onRouteChange: (() -> Void)?
  private(set) var rate: Double = 48_000
  private(set) var echoCancelled = false

  init(live: Bool, onAudio: @escaping ([Float]) -> Void) {
    self.live = live
    self.onAudio = onAudio
  }

  /// Sets up the session; the rate the audio will come at.
  func prepare() throws -> Double {
    let session = AVAudioSession.sharedInstance()
    saved = (session.category, session.mode, session.categoryOptions)
    if live {
      try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP, .mixWithOthers])
      if #available(iOS 18.2, *), session.isEchoCancelledInputAvailable {
        try session.setPrefersEchoCancelledInput(true)
      }
    } else {
      try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetoothA2DP])
    }
    try session.setActive(true)
    if #available(iOS 18.2, *) {
      echoCancelled = live && session.isEchoCancelledInputEnabled
    }
    rate = engine.inputNode.outputFormat(forBus: 0).sampleRate
    return rate
  }

  func start() throws {
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    let channels = Int(format.channelCount)
    input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
      guard let self, let data = buffer.floatChannelData else { return }
      let frames = Int(buffer.frameLength)
      var mono = [Float](repeating: 0, count: frames)
      for channel in 0..<channels {
        let samples = data[channel]
        for i in 0..<frames { mono[i] += samples[i] / Float(channels) }
      }
      self.onAudio(mono)
    }
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
      let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init)
      if type == .began { self?.onInterrupted?("interruption") }
    })
    observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) { [weak self] _ in
      self?.onInterrupted?("mediaServicesReset")
    })
    observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { [weak self] _ in
      self?.onRouteChange?()
    })
    engine.prepare()
    try engine.start()
  }

  /// The microphone as the session tells of it, for diagnostics.
  func input() -> [String: Any] {
    let session = AVAudioSession.sharedInstance()
    let port = session.currentRoute.inputs.first
    let format = engine.inputNode.outputFormat(forBus: 0)
    var details: [String: Any] = [
      "session rate": Int(session.sampleRate),
      "input latency ms": Int((session.inputLatency * 1000).rounded()),
      "buffer ms": Int((session.ioBufferDuration * 1000).rounded()),
      "input gain": (Double(session.inputGain) * 100).rounded() / 100,
      "gain settable": session.isInputGainSettable,
      "voice processing": engine.inputNode.isVoiceProcessingEnabled,
      "output": session.currentRoute.outputs.map(\.portName).joined(separator: ", "),
      "inputs available": (session.availableInputs ?? []).map(\.portName).joined(separator: ", "),
    ]
    if let source = session.inputDataSource {
      details["data source"] = source.dataSourceName
      if let pattern = source.selectedPolarPattern { details["polar pattern"] = pattern.rawValue }
    }
    if #available(iOS 18.2, *) {
      details["echo-cancelled input available"] = session.isEchoCancelledInputAvailable
    }
    let name = { (raw: String, prefix: String) in raw.hasPrefix(prefix) ? String(raw.dropFirst(prefix.count)) : raw }
    return [
      "device": port?.portName ?? "microphone",
      "kind": Capture.kind(port?.portType),
      "rate": Int(format.sampleRate),
      "channels": Int(format.channelCount),
      "processing": "\(name(session.category.rawValue, "AVAudioSessionCategory")) · \(name(session.mode.rawValue, "AVAudioSessionMode"))",
      "echoCancellation": echoCancelled,
      "details": details,
    ]
  }

  private static func kind(_ type: AVAudioSession.Port?) -> String {
    switch type {
    case .builtInMic?: return "builtIn"
    case .headsetMic?, .lineIn?: return "wired"
    case .bluetoothHFP?: return "bluetooth"
    case .usbAudio?: return "usb"
    default: return "other"
    }
  }

  /// Stops listening and gives the session back as it was found, letting others play on.
  func stop() {
    observers.forEach(NotificationCenter.default.removeObserver)
    observers = []
    if engine.isRunning { engine.stop() }
    engine.inputNode.removeTap(onBus: 0)
    let session = AVAudioSession.sharedInstance()
    if let saved {
      try? session.setCategory(saved.category, mode: saved.mode, options: saved.options)
    }
    try? session.setActive(false, options: .notifyOthersOnDeactivation)
    saved = nil
  }
}
