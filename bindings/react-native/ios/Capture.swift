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
    engine.prepare()
    try engine.start()
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
