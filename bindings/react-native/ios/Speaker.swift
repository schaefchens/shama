import AVFAudio
import Foundation

/// Shama's own voice, for its replies in LIVE: the device's voices, which speak on the device.
final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
  private let synthesizer = AVSpeechSynthesizer()
  private var finished: [ObjectIdentifier: () -> Void] = [:]

  override init() {
    super.init()
    synthesizer.delegate = self
    // Its own session: the app's – and Shama's listening one – stay as they are.
    synthesizer.usesApplicationAudioSession = false
  }

  func speak(_ text: String, language: String, done: @escaping () -> Void) {
    let utterance = AVSpeechUtterance(string: text)
    guard let voice = AVSpeechSynthesisVoice(language: AppleRecognizer.locale(language)) else {
      done()
      return
    }
    utterance.voice = voice
    DispatchQueue.main.async {
      self.finished[ObjectIdentifier(utterance)] = done
      self.synthesizer.speak(utterance)
    }
  }

  func stop() {
    DispatchQueue.main.async { self.synthesizer.stopSpeaking(at: .immediate) }
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    finished.removeValue(forKey: ObjectIdentifier(utterance))?()
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    finished.removeValue(forKey: ObjectIdentifier(utterance))?()
  }
}
