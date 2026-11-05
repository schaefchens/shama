import AVFAudio
import Foundation
import Speech

/// Apple's recognizer, held on the device: `requiresOnDeviceRecognition`, never its server. Given
/// an utterance's audio at once, it answers with its readings – the best first – favoring the
/// app's phrases. Called on Shama's queue, it waits there until it has heard.
final class AppleRecognizer: PlatformRecognizer, @unchecked Sendable {
  private let recognizer: SFSpeechRecognizer

  /// The recognizer for a language, where the device has it on board.
  init?(language: String) {
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: Self.locale(language))),
      recognizer.supportsOnDeviceRecognition
    else { return nil }
    recognizer.queue = OperationQueue()
    self.recognizer = recognizer
  }

  static func locale(_ language: String) -> String {
    ["en": "en-US", "de": "de-DE", "tr": "tr-TR", "ar": "ar-SA", "fa": "fa-IR"][language] ?? language
  }

  /// "ready", "downloadable" – the language is there, its on-device model not – or "unsupported".
  static func support(_ language: String) -> String {
    let locale = Locale(identifier: locale(language))
    guard SFSpeechRecognizer.supportedLocales().contains(where: { $0.identifier.replacingOccurrences(of: "_", with: "-") == locale.identifier }),
      let recognizer = SFSpeechRecognizer(locale: locale)
    else { return "unsupported" }
    return recognizer.supportsOnDeviceRecognition ? "ready" : "downloadable"
  }

  func name() -> String {
    "os:apple"
  }

  func recognize(language: String, bias: [String], audio: Data) throws -> String {
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = false
    request.addsPunctuation = false
    request.taskHint = .search
    request.contextualStrings = Array(bias.prefix(100))
    let frames = audio.count / 2
    guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true),
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
      let channel = buffer.int16ChannelData?[0]
    else { throw RecognizerError.Failed(reason: "no audio buffer") }
    buffer.frameLength = AVAudioFrameCount(frames)
    audio.withUnsafeBytes { bytes in
      for i in 0..<frames { channel[i] = Int16(littleEndian: bytes.loadUnaligned(fromByteOffset: i * 2, as: Int16.self)) }
    }
    request.append(buffer)
    request.endAudio()

    let done = DispatchSemaphore(value: 0)
    var answer: Result<String, Error> = .failure(RecognizerError.Failed(reason: "nothing heard"))
    let task = recognizer.recognitionTask(with: request) { result, error in
      if let result, result.isFinal {
        answer = .success(Self.readings(result))
        done.signal()
      } else if let error {
        // "No speech detected" is an answer too: nothing.
        answer = (error as NSError).code == 1110 ? .success("[]") : .failure(error)
        done.signal()
      }
    }
    let waited = done.wait(timeout: .now() + 10)
    channel.update(repeating: 0, count: frames)
    if waited == .timedOut {
      task.cancel()
      throw RecognizerError.Failed(reason: "the recognizer took too long")
    }
    do {
      return try answer.get()
    } catch {
      throw RecognizerError.Failed(reason: error.localizedDescription)
    }
  }

  /// The readings as JSON, each with the mean confidence of its words.
  private static func readings(_ result: SFSpeechRecognitionResult) -> String {
    let readings: [[String: Any]] = result.transcriptions.prefix(5).map { transcription in
      var reading: [String: Any] = ["text": transcription.formattedString]
      let confidences = transcription.segments.map(\.confidence).filter { $0 > 0 }
      if !confidences.isEmpty {
        reading["confidence"] = confidences.reduce(0, +) / Float(confidences.count)
      }
      return reading
    }
    let data = (try? JSONSerialization.data(withJSONObject: readings)) ?? Data("[]".utf8)
    return String(decoding: data, as: UTF8.self)
  }
}
