// Apple's speech recognition, on the device only, over Shama's corpus.
//
//   apple-speech probe <out.json>
//   apple-speech run <root> <lang> <locale> <out.jsonl> <bias: none|context|customlm> <feed: fast|realtime> [kinds] [limit]
//
// probe lists the locales the recognizer knows and which of them recognize on the device. run
// feeds each WAV of shama/.cache/corpus/<lang> as audio buffers – as fast as they go, or at the
// pace they were spoken – and writes what was heard (all alternatives), with the time from the
// end of the audio to the final result.
import AVFoundation
import Foundation
import Speech

func write(_ object: Any, to path: String) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
    try! data.write(to: URL(fileURLWithPath: path))
}

func authorize() async -> SFSpeechRecognizerAuthorizationStatus {
    if SFSpeechRecognizer.authorizationStatus() != .notDetermined { return SFSpeechRecognizer.authorizationStatus() }
    return await withCheckedContinuation { continuation in
        SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
    }
}

func statusName(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch status {
    case .authorized: "authorized"
    case .denied: "denied"
    case .restricted: "restricted"
    case .notDetermined: "notDetermined"
    @unknown default: "unknown"
    }
}

func probe(out: String) async {
    let status = await authorize()
    let languages = ["en", "de", "tr", "ar", "fa"]
    let supported = SFSpeechRecognizer.supportedLocales().map(\.identifier).filter { id in
        languages.contains { id.hasPrefix($0 + "-") || id.hasPrefix($0 + "_") || id == $0 }
    }.sorted()
    var locales: [[String: Any]] = []
    for id in ["en-US", "de-DE", "tr-TR", "ar-SA", "ar-AE", "fa-IR"] {
        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: id))
        locales.append([
            "locale": id, "exists": recognizer != nil, "available": recognizer?.isAvailable ?? false,
            "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
        ])
    }
    write(["authorization": statusName(status), "supported": supported, "locales": locales], to: out)
}

struct Entry {
    let json: [String: Any]
    var file: String { json["file"] as! String }
}

func entries(root: String, lang: String, kinds: Set<String>, limit: Int) -> [Entry] {
    var list: [Entry] = []
    for name in ["manifest.jsonl", "fleurs.jsonl", "noise.jsonl", "variants.jsonl"] {
        guard let text = try? String(contentsOfFile: "\(root)/.cache/corpus/\(lang)/\(name)", encoding: .utf8) else { continue }
        for line in text.split(separator: "\n") where !line.isEmpty {
            let json = try! JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
            if kinds.isEmpty || kinds.contains(json["kind"] as! String) { list.append(Entry(json: json)) }
        }
    }
    return limit > 0 ? Array(list.prefix(limit)) : list
}

// Phrases for contextualStrings: the corpus' names and commands, at most 100 as Apple advises.
func contextPhrases(root: String, lang: String) -> [String] {
    let data = try! Data(contentsOf: URL(fileURLWithPath: "\(root)/tools/corpus/commands/\(lang).json"))
    let spec = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    let phrases = (spec["books"] as! [String]) + (spec["surahs"] as! [String]) + (spec["commands"] as! [String])
    return Array(phrases.prefix(100))
}

// A custom language model: the corpus' templates with classes for names and numbers.
func customModel(root: String, lang: String, locale: Locale) async throws -> SFSpeechLanguageModel.Configuration {
    let data = try Data(contentsOf: URL(fileURLWithPath: "\(root)/tools/corpus/commands/\(lang).json"))
    let spec = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    let numbers = (1...300).map(String.init)
    let classes: [String: [String]] = [
        "book": spec["books"] as! [String], "surah": spec["surahs"] as! [String],
        "c": numbers, "v": numbers, "s": numbers, "a": numbers,
    ]
    let templates = (spec["templates"] as! [String]).map { template in
        template.replacingOccurrences(of: "{", with: "<").replacingOccurrences(of: "}", with: ">")
    }
    let commands = spec["commands"] as! [String]
    let model = SFCustomLanguageModelData(locale: locale, identifier: "de.schaefchens.shama.bench.\(lang)", version: "1.0") {
        for command in commands { SFCustomLanguageModelData.PhraseCount(phrase: command, count: 100) }
        SFCustomLanguageModelData.PhraseCountsFromTemplates(classes: classes) {
            for template in templates { SFCustomLanguageModelData.TemplatePhraseCountGenerator.Template(template, count: 1000) }
        }
    }
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("shama-lm-\(lang)")
    try? FileManager.default.removeItem(at: dir)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let asset = dir.appendingPathComponent("model.bin")
    try await model.export(to: asset)
    let configuration = SFSpeechLanguageModel.Configuration(
        languageModel: dir.appendingPathComponent("LM"), vocabulary: dir.appendingPathComponent("Vocab"))
    try await SFSpeechLanguageModel.prepareCustomLanguageModel(
        for: asset, clientIdentifier: "de.schaefchens.shama.bench", configuration: configuration)
    return configuration
}

final class Box: @unchecked Sendable {
    var result: SFSpeechRecognitionResult?
    var error: Error?
    var finished: Date?
}

func recognize(
    _ recognizer: SFSpeechRecognizer, file: String, context: [String], model: SFSpeechLanguageModel.Configuration?,
    realtime: Bool
) async -> (SFSpeechRecognitionResult?, Error?, Double, Double) {
    let audio = try! AVAudioFile(forReading: URL(fileURLWithPath: file))
    let format = audio.processingFormat
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = false
    request.addsPunctuation = false
    request.taskHint = .search
    if !context.isEmpty { request.contextualStrings = context }
    if let model { request.customizedLanguageModel = model }
    let box = Box()
    let done = AsyncStream<Void>.makeStream()
    let task = recognizer.recognitionTask(with: request) { result, error in
        if let result, result.isFinal {
            box.result = result
            box.finished = Date()
            done.continuation.finish()
        }
        if let error {
            box.error = error
            box.finished = Date()
            done.continuation.finish()
        }
    }
    let chunk: AVAudioFrameCount = 1600
    let audioMs = Double(audio.length) / format.sampleRate * 1000
    while audio.framePosition < audio.length {
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunk)!
        try! audio.read(into: buffer, frameCount: chunk)
        request.append(buffer)
        if realtime { try? await Task.sleep(nanoseconds: UInt64(Double(buffer.frameLength) / format.sampleRate * 1e9)) }
    }
    request.endAudio()
    let ended = Date()
    let timeout = Task {
        try? await Task.sleep(nanoseconds: 20_000_000_000)
        task.cancel()
        done.continuation.finish()
    }
    for await _ in done.stream {}
    timeout.cancel()
    let latency = (box.finished ?? Date()).timeIntervalSince(ended) * 1000
    return (box.result, box.error, latency, audioMs)
}

func run(_ args: [String]) async {
    let (root, lang, locale, out, bias, feed) = (args[0], args[1], args[2], args[3], args[4], args[5])
    let kinds = Set((args.count > 6 ? args[6] : "").split(separator: ",").map(String.init))
    let limit = args.count > 7 ? Int(args[7])! : 0
    let status = await authorize()
    FileManager.default.createFile(atPath: out, contents: nil)
    let handle = FileHandle(forWritingAtPath: out)!
    func emit(_ object: [String: Any]) {
        handle.write(try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
        handle.write("\n".data(using: .utf8)!)
    }
    guard status == .authorized, let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)) else {
        emit(["error": "not authorized or no recognizer", "authorization": statusName(status)])
        return
    }
    guard recognizer.supportsOnDeviceRecognition else {
        emit(["error": "no on-device recognition for \(locale)"])
        return
    }
    let context = bias == "context" ? contextPhrases(root: root, lang: lang) : []
    var model: SFSpeechLanguageModel.Configuration?
    if bias == "customlm" {
        let started = Date()
        do {
            model = try await customModel(root: root, lang: lang, locale: Locale(identifier: locale))
            emit(["customlm_prepare_ms": Date().timeIntervalSince(started) * 1000])
        } catch {
            emit(["error": "custom language model: \(error)"])
            return
        }
    }
    for entry in entries(root: root, lang: lang, kinds: kinds, limit: limit) {
        let (result, error, latency, audioMs) = await recognize(
            recognizer, file: "\(root)/\(entry.file)", context: context, model: model, realtime: feed == "realtime")
        let hypotheses: [[String: Any]] = (result?.transcriptions ?? []).prefix(5).map { transcription in
            let confidences = transcription.segments.map { Double($0.confidence) }
            let confidence = confidences.isEmpty ? 0 : confidences.reduce(0, +) / Double(confidences.count)
            return ["text": transcription.formattedString, "confidence": (confidence * 1000).rounded() / 1000]
        }
        var line: [String: Any] = [
            "id": entry.json["id"]!, "kind": entry.json["kind"]!, "voice": entry.json["voice"]!,
            "expected": entry.json["expected"]!, "hypotheses": hypotheses,
            "latency_ms": (latency * 10).rounded() / 10, "audio_ms": audioMs.rounded(),
        ]
        if let error { line["error"] = (error as NSError).localizedDescription + " (\((error as NSError).code))" }
        emit(line)
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
switch arguments.first {
case "probe": await probe(out: arguments[1])
case "run": await run(Array(arguments.dropFirst()))
default: print("apple-speech probe <out.json> | run <root> <lang> <locale> <out.jsonl> <bias> <feed> [kinds] [limit]")
}
