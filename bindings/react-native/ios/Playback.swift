import AVFAudio
import Foundation

/// Utterances' audio kept for debugging, played back: through the session as it is while Shama
/// listens; otherwise in one for playback – heard with the ringer off too – given back after.
final class Playback: NSObject, AVAudioPlayerDelegate {
  private var player: AVAudioPlayer?
  private var done: (() -> Void)?
  private var saved: (category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions)?

  /// Called on the main thread.
  func play(_ wav: Data, listening: Bool, done: @escaping () -> Void) throws {
    stop()
    let session = AVAudioSession.sharedInstance()
    if !listening {
      saved = (session.category, session.mode, session.categoryOptions)
      try session.setCategory(.playback, mode: .default)
      try session.setActive(true)
    }
    let player = try AVAudioPlayer(data: wav)
    player.delegate = self
    self.player = player
    self.done = done
    player.play()
  }

  func stop() {
    player?.stop()
    finish()
  }

  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    finish()
  }

  private func finish() {
    player = nil
    if let saved {
      let session = AVAudioSession.sharedInstance()
      try? session.setCategory(saved.category, mode: saved.mode, options: saved.options)
      try? session.setActive(false, options: .notifyOthersOnDeactivation)
      self.saved = nil
    }
    done?()
    done = nil
  }
}
