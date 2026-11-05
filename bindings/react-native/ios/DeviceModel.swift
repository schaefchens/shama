import Foundation

#if canImport(FoundationModels)
  import FoundationModels
#endif

/// The system's own language model – Apple Foundation Models, iOS 26 and later, where Apple
/// Intelligence is on and speaks the language. It gets the words heard here, in native code.
enum DeviceModel {
  static func available(_ language: String) -> Bool {
    #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        let model = SystemLanguageModel.default
        guard case .available = model.availability else { return false }
        return model.supportedLanguages.contains { $0.languageCode?.identifier == language }
      }
    #endif
    return false
  }

  /// Asks the model for calls to the tools offered; its answer as Shama's AI reply, in JSON.
  static func decide(request json: String, timeoutMs: Int) async throws -> String {
    #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        guard let request = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
          let system = request["system"] as? String,
          let message = request["message"] as? String
        else { throw DeviceModelError.invalid }
        let tools = (try? JSONSerialization.data(withJSONObject: request["tools"] ?? [])).map { String(decoding: $0, as: UTF8.self) } ?? "[]"
        let maxCalls = request["maxCalls"] as? Int ?? 3
        let instructions = """
          \(system)

          Answer with JSON only, nothing around it: {"calls": [{"tool": "<name>", "args": {…}}], "reply": "<optional short sentence>"} – at most \(maxCalls) calls, to these tools:
          \(tools)
          """
        let content = try await withTimeout(ms: timeoutMs) {
          try await LanguageModelSession(instructions: instructions).respond(to: message).content
        }
        return extractJSON(content)
      }
    #endif
    throw DeviceModelError.unavailable
  }

  /// The JSON object in a model's answer, should it have written words around it.
  private static func extractJSON(_ text: String) -> String {
    guard let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}") else { return #"{"calls":[]}"# }
    return String(text[start...end])
  }

  private static func withTimeout<T: Sendable>(ms: Int, _ work: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
      group.addTask { try await work() }
      group.addTask {
        try await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
        throw DeviceModelError.timeout
      }
      let first = try await group.next()!
      group.cancelAll()
      return first
    }
  }
}

enum DeviceModelError: Error {
  case unavailable
  case invalid
  case timeout
}
