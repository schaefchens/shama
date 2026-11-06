import AVFAudio
import ExpoModulesCore
import Network
import Speech
import UIKit

/// Shama for React Native on iOS: one core, driven from one serial queue – the microphone's audio,
/// JS's calls, the system's recognizer – whose events go to JS as JSON. What was heard stays here.
public class ShamaModule: Module {
  private let queue = DispatchQueue(label: "de.schaefchens.shama", qos: .userInitiated)
  private let core = ShamaCore()
  private let speaker = Speaker()
  private let playback = Playback()
  private let network = NWPathMonitor()
  private var online = true
  private var capture: Capture?
  private var held = false
  private var background: NSObjectProtocol?
  /// The languages the app's embedded models hear.
  private var embedded = Set<String>()

  public func definition() -> ModuleDefinition {
    Name("Shama")

    Events("onPortEvent")

    OnCreate {
      self.network.pathUpdateHandler = { [weak self] path in self?.online = path.status == .satisfied }
      self.network.start(queue: DispatchQueue(label: "de.schaefchens.shama.network"))
      // Foreground only: an app that leaves the screen stops listening.
      self.background = NotificationCenter.default.addObserver(
        forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
      ) { [weak self] _ in
        guard let self, self.capture != nil else { return }
        self.stopCapture()
        self.emit(["event": "interrupted", "reason": "background"])
      }
    }

    OnDestroy {
      self.stopCapture()
      self.network.cancel()
      if let background = self.background { NotificationCenter.default.removeObserver(background) }
    }

    // The app's embedded models: a folder per language.
    AsyncFunction("configure") { (folders: [String: String]) -> [[String: Any]] in
      var models: [String: String] = [:]
      for (language, folder) in folders {
        models[language] = folder.hasPrefix("file://") ? (URL(string: folder)?.path ?? folder) : folder
      }
      let json = String(decoding: try JSONSerialization.data(withJSONObject: models), as: UTF8.self)
      let embedded = Set(try self.queue.sync { try self.core.setModels(json: json) })
      self.queue.sync { self.embedded = embedded }
      return ["en", "de", "tr", "ar", "fa"].map { language in
        let os = AppleRecognizer.support(language)
        return [
          "language": language,
          "recognizer": os == "ready" ? "os" : embedded.contains(language) ? "embedded" : "none",
          "os": os,
          "embedded": embedded.contains(language) ? "installed" : "missing",
          "deviceAi": DeviceModel.available(language),
        ]
      }
    }

    AsyncFunction("setVocabulary") { (json: String) -> String in
      self.queue.sync { self.core.setVocabulary(json: json) }
    }

    Function("setTurn") { (json: String) in
      self.queue.async { try? self.core.setTurn(json: json) }
    }

    AsyncFunction("listen") { (json: String) in
      try self.listen(json)
    }

    AsyncFunction("release") {
      let events = self.queue.sync { self.core.release() }
      self.stopCapture()
      self.emit(json: events)
    }

    Function("hold") { (paused: Bool) in
      self.queue.async { self.held = paused }
    }

    AsyncFunction("stop") {
      self.stopCapture()
      self.queue.sync { self.core.stop() }
    }

    AsyncFunction("heard") { (id: Int) -> String? in
      self.queue.sync { self.core.heard(id: UInt32(id)) }
    }

    Function("forget") { (id: Int) in
      self.queue.async { self.core.forget(id: UInt32(id)) }
    }

    // Utterances' audio kept for debugging: played here, saved to the app's documents – never to JS.
    AsyncFunction("playRecording") { (id: Int, promise: Promise) in
      guard let wav = self.queue.sync(execute: { self.core.recordingWav(id: UInt32(id)) }) else {
        return promise.reject(Exception(name: "NoRecording", description: "no audio kept for utterance \(id)"))
      }
      DispatchQueue.main.async {
        do {
          try self.playback.play(wav, listening: self.capture != nil) { promise.resolve(nil) }
        } catch {
          promise.reject(Exception(name: "Playback", description: error.localizedDescription))
        }
      }
    }

    Function("stopPlaying") {
      DispatchQueue.main.async { self.playback.stop() }
    }

    AsyncFunction("saveRecording") { (id: Int) -> [String: String] in
      guard let wav = self.queue.sync(execute: { self.core.recordingWav(id: UInt32(id)) }) else {
        throw Exception(name: "NoRecording", description: "no audio kept for utterance \(id)")
      }
      let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("shama-recordings", isDirectory: true)
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      let formatter = DateFormatter()
      formatter.locale = Locale(identifier: "en_US_POSIX")
      formatter.dateFormat = "yyyyMMdd-HHmmss"
      let name = "shama-\(formatter.string(from: Date()))-\(id).wav"
      let url = folder.appendingPathComponent(name)
      try wav.write(to: url, options: .atomic)
      return ["uri": url.absoluteString, "name": name]
    }

    Function("forgetRecordings") {
      self.queue.async { self.core.forgetRecordings() }
    }

    AsyncFunction("finishCall") { (call: String) -> String in
      try self.queue.sync { try self.core.finishCall(call: call) }
    }

    AsyncFunction("aiRequest") { (id: Int, options: String) -> String? in
      try self.queue.sync { try self.core.aiRequest(id: UInt32(id), options: options) }
    }

    AsyncFunction("checkReply") { (reply: String, options: String) -> String in
      try self.queue.sync { try self.core.checkReply(reply: reply, options: options) }
    }

    AsyncFunction("deviceAiAvailable") { (language: String) -> Bool in
      DeviceModel.available(language)
    }

    // The system's model gets the words heard here: they don't pass through JS.
    AsyncFunction("deviceAi") { (id: Int, options: String, timeoutMs: Int) async throws -> String in
      guard let request = try self.queue.sync(execute: { try self.core.aiRequest(id: UInt32(id), options: options) }) else {
        throw Exception(name: "Unavailable", description: "nothing heard to ask about")
      }
      return try await DeviceModel.decide(request: request, timeoutMs: timeoutMs)
    }

    AsyncFunction("speak") { (text: String, language: String, promise: Promise) in
      self.speaker.speak(text, language: language) { promise.resolve(nil) }
    }

    Function("stopSpeaking") {
      self.speaker.stop()
    }

    AsyncFunction("online") { () -> Bool in
      self.online
    }

    AsyncFunction("requestPermission") { (promise: Promise) in
      let microphone: (@escaping (Bool) -> Void) -> Void = { done in
        if #available(iOS 17.0, *) {
          AVAudioApplication.requestRecordPermission(completionHandler: done)
        } else {
          AVAudioSession.sharedInstance().requestRecordPermission(done)
        }
      }
      microphone { granted in
        guard granted else { return promise.resolve(false) }
        SFSpeechRecognizer.requestAuthorization { status in promise.resolve(status == .authorized) }
      }
    }
  }

  private struct ListenOptions: Decodable {
    var language: String
    var mode: String
    var echoCancellation: Bool?
    var file: String?
    var text: String?
    var recognizer: String?
    var diagnostics: Bool?
  }

  private func listen(_ json: String) throws {
    let options = try JSONDecoder().decode(ListenOptions.self, from: Data(json.utf8))
    stopCapture()
    if let text = options.text {
      queue.async {
        do {
          self.emit(json: try self.core.listenText(options: json, text: text))
        } catch {
          self.emit(["event": "failed", "message": error.localizedDescription])
        }
      }
      return
    }
    if let file = options.file {
      let path = file.hasPrefix("file://") ? (URL(string: file)?.path ?? file) : file
      // A recording is heard by the fixture recognizer – or by the system's or the embedded one,
      // when asked for.
      let recognizer: PlatformRecognizer? = options.recognizer == "os" ? try osRecognizer(options.language) : nil
      queue.async {
        do {
          self.emit(json: try self.core.listenFile(options: json, path: path, recognizer: recognizer))
        } catch {
          self.emit(["event": "failed", "message": error.localizedDescription])
        }
      }
      return
    }
    // The system's recognizer where it hears the language on the device, else the app's model.
    let choice = options.recognizer ?? "auto"
    let embedded = queue.sync { self.embedded }
    let useEmbedded = choice == "embedded"
      || (choice == "auto" && embedded.contains(options.language) && AppleRecognizer.support(options.language) != "ready")
    let recognizer: PlatformRecognizer? = useEmbedded ? nil : try osRecognizer(options.language)
    let listenJson = useEmbedded ? try withRecognizer(json, "embedded") : json
    let live = options.mode == "continuous"
    let capture = Capture(live: live && options.echoCancellation == true) { [weak self] samples in
      self?.queue.async {
        guard let self, !self.held else { return }
        self.emit(json: self.core.push(samples: samples))
      }
    }
    capture.onInterrupted = { [weak self] reason in
      self?.stopCapture()
      self?.emit(["event": "interrupted", "reason": reason])
    }
    if options.diagnostics == true {
      capture.onRouteChange = { [weak self, weak capture] in
        guard let capture else { return }
        self?.emit(["event": "input", "input": capture.input()])
      }
    }
    let rate = try capture.prepare()
    try queue.sync {
      held = false
      try core.listen(options: listenJson, rate: UInt32(rate.rounded()), recognizer: recognizer)
    }
    do {
      try capture.start()
    } catch {
      capture.stop()
      throw error
    }
    self.capture = capture
    if options.diagnostics == true {
      emit(["event": "input", "input": capture.input()])
    }
    if live && options.echoCancellation == true {
      emit(["event": "echoCancellation", "available": capture.echoCancelled])
    }
  }

  /// The listen options with the recognizer chosen.
  private func withRecognizer(_ json: String, _ recognizer: String) throws -> String {
    var options = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] ?? [:]
    options["recognizer"] = recognizer
    return String(decoding: try JSONSerialization.data(withJSONObject: options), as: UTF8.self)
  }

  private func osRecognizer(_ language: String) throws -> AppleRecognizer {
    guard let recognizer = AppleRecognizer(language: language) else {
      throw Exception(name: "NoRecognizer", description: "This device has no recognizer on board for \(language)")
    }
    return recognizer
  }

  private func stopCapture() {
    capture?.stop()
    capture = nil
  }

  private func emit(json: String) {
    if json != "[]" { sendEvent("onPortEvent", ["json": json]) }
  }

  private func emit(_ event: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: [event]) else { return }
    sendEvent("onPortEvent", ["json": String(decoding: data, as: UTF8.self)])
  }
}
