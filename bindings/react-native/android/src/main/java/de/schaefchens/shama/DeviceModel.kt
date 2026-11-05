package de.schaefchens.shama

import android.os.Build
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.prompt.Generation
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject

/**
 * The system's own language model: Gemini Nano through ML Kit, on the phones that have it. It
 * gets the words heard here, in native code.
 */
object DeviceModel {
  fun available(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
    return runCatching { runBlocking { Generation.getClient().checkStatus() == FeatureStatus.AVAILABLE } }.getOrDefault(false)
  }

  /** Asks the model for calls to the tools offered; its answer as Shama's AI reply, in JSON. */
  fun decide(request: String, timeoutMs: Int): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) throw IllegalStateException("no language model on this device")
    val json = JSONObject(request)
    val maxCalls = json.optInt("maxCalls", 3)
    val prompt = """
      ${json.getString("system")}

      Answer with JSON only, nothing around it: {"calls": [{"tool": "<name>", "args": {…}}], "reply": "<optional short sentence>"} – at most $maxCalls calls, to these tools:
      ${json.getJSONArray("tools")}

      ${json.getString("message")}
    """.trimIndent()
    val text = runBlocking {
      withTimeout(timeoutMs.toLong()) { Generation.getClient().generateContent(prompt).candidates.firstOrNull()?.text.orEmpty() }
    }
    val start = text.indexOf('{')
    val end = text.lastIndexOf('}')
    return if (start >= 0 && end > start) text.substring(start, end + 1) else """{"calls":[]}"""
  }
}
