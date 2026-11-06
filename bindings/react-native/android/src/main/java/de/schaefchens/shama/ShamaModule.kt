package de.schaefchens.shama

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import androidx.core.content.ContextCompat
import de.schaefchens.shama.core.ShamaCore
import expo.modules.interfaces.permissions.PermissionsResponse
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors

/**
 * Shama for React Native on Android: one core, driven from one thread – the microphone's audio,
 * JS's calls, the system's recognizer – whose events go to JS as JSON. What was heard stays here.
 */
class ShamaModule : Module() {
  private val executor = Executors.newSingleThreadExecutor { Thread(it, "shama") }
  private val core by lazy { ShamaCore() }
  private val speaker by lazy { Speaker(context) }
  private val playback = Playback()
  private var capture: Capture? = null
  @Volatile private var held = false
  /** The languages the app's embedded models hear. */
  @Volatile private var embedded = emptySet<String>()

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("no React context")

  override fun definition() = ModuleDefinition {
    Name("Shama")

    Events("onPortEvent")

    OnActivityEntersBackground {
      // Foreground only: an app that leaves the screen stops listening.
      if (capture != null) {
        stopCapture()
        emit(JSONObject().put("event", "interrupted").put("reason", "background"))
      }
    }

    OnDestroy {
      stopCapture()
      speaker.shutdown()
      executor.shutdown()
    }

    // The app's embedded models: a folder per language.
    AsyncFunction("configure") { folders: Map<String, String> ->
      val models = JSONObject()
      folders.forEach { (language, folder) -> models.put(language, folder.removePrefix("file://")) }
      embedded = onQueue { core.setModels(models.toString()) }.toSet()
      val deviceAi = DeviceModel.available()
      listOf("en", "de", "tr", "ar", "fa").map { language ->
        val os = AndroidRecognizer.support(context, language)
        mapOf(
          "language" to language,
          "recognizer" to when {
            os == "ready" -> "os"
            language in embedded -> "embedded"
            else -> "none"
          },
          "os" to os,
          "embedded" to if (language in embedded) "installed" else "missing",
          "deviceAi" to deviceAi,
        )
      }
    }

    AsyncFunction("setVocabulary") { json: String -> onQueue { core.setVocabulary(json) } }

    Function("setTurn") { json: String -> executor.execute { runCatching { core.setTurn(json) } } }

    AsyncFunction("listen") { json: String -> listen(json) }

    AsyncFunction("release") {
      val events = onQueue { core.release() }
      stopCapture()
      emit(events)
    }

    Function("hold") { paused: Boolean -> held = paused }

    AsyncFunction("stop") {
      stopCapture()
      onQueue { core.stop() }
    }

    AsyncFunction("heard") { id: Int -> onQueue { core.heard(utterance(id)) } }

    Function("forget") { id: Int -> executor.execute { core.forget(utterance(id)) } }

    // Utterances' audio kept for debugging: played here, saved to the app's files – never to JS.
    AsyncFunction("playRecording") { id: Int, promise: Promise ->
      val pcm = onQueue { core.recordingPcm16(utterance(id)) }
        ?: return@AsyncFunction promise.reject(CodedException("NoRecording", "no audio kept for utterance $id", null))
      playback.play(pcm) { promise.resolve(null) }
    }

    Function("stopPlaying") { playback.stop() }

    AsyncFunction("saveRecording") { id: Int ->
      val wav = onQueue { core.recordingWav(utterance(id)) }
        ?: throw CodedException("NoRecording", "no audio kept for utterance $id", null)
      // The app's external files, where adb reaches them; its own where there are none.
      val folder = File(context.getExternalFilesDir(null) ?: context.filesDir, "shama-recordings").apply { mkdirs() }
      val name = "shama-${SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(Date())}-$id.wav"
      val file = File(folder, name)
      file.writeBytes(wav)
      wav.fill(0)
      mapOf("uri" to Uri.fromFile(file).toString(), "name" to name)
    }

    Function("forgetRecordings") { executor.execute { core.forgetRecordings() } }

    AsyncFunction("finishCall") { call: String -> onQueue { core.finishCall(call) } }

    AsyncFunction("aiRequest") { id: Int, options: String -> onQueue { core.aiRequest(utterance(id), options) } }

    AsyncFunction("checkReply") { reply: String, options: String -> onQueue { core.checkReply(reply, options) } }

    AsyncFunction("deviceAiAvailable") { _: String -> DeviceModel.available() }

    // The system's model gets the words heard here: they don't pass through JS.
    AsyncFunction("deviceAi") { id: Int, options: String, timeoutMs: Int ->
      val request = onQueue { core.aiRequest(utterance(id), options) } ?: throw CodedException("Unavailable", "nothing heard to ask about", null)
      DeviceModel.decide(request, timeoutMs)
    }

    AsyncFunction("speak") { text: String, language: String, promise: Promise ->
      speaker.speak(text, language) { promise.resolve(null) }
    }

    Function("stopSpeaking") { speaker.stop() }

    AsyncFunction("online") {
      val manager = context.getSystemService(ConnectivityManager::class.java)
      val capabilities = manager?.getNetworkCapabilities(manager.activeNetwork)
      capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
    }

    AsyncFunction("requestPermission") { promise: Promise ->
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
        promise.resolve(true)
        return@AsyncFunction
      }
      val permissions = appContext.permissions ?: return@AsyncFunction promise.resolve(false)
      permissions.askForPermissions({ result: Map<String, PermissionsResponse> ->
        promise.resolve(result[Manifest.permission.RECORD_AUDIO]?.status == PermissionsStatus.GRANTED)
      }, Manifest.permission.RECORD_AUDIO)
    }
  }

  private fun listen(json: String) {
    val options = JSONObject(json)
    val language = options.getString("language")
    val choice = options.optString("recognizer").ifEmpty { "auto" }
    stopCapture()
    if (options.has("text")) {
      val text = options.getString("text")
      executor.execute {
        try {
          emit(core.listenText(json, text))
        } catch (error: Exception) {
          emit(JSONObject().put("event", "failed").put("message", error.message ?: error.toString()))
        }
      }
      return
    }
    val file = options.optString("file").takeIf { it.isNotEmpty() }
    if (file != null) {
      val path = file.removePrefix("file://")
      // A recording is heard by the fixture recognizer – or by the system's or the embedded one,
      // when asked for.
      val recognizer = if (choice == "os") osRecognizer(language) else null
      executor.execute {
        try {
          emit(core.listenFile(json, path, recognizer))
        } catch (error: Exception) {
          emit(JSONObject().put("event", "failed").put("message", error.message ?: error.toString()))
        }
      }
      return
    }
    // The system's recognizer where it hears the language on the device, else the app's model.
    val useEmbedded = choice == "embedded" ||
      (choice == "auto" && language in embedded && AndroidRecognizer.support(context, language) != "ready")
    val recognizer = if (useEmbedded) null else osRecognizer(language)
    val listenJson = if (useEmbedded) options.put("recognizer", "embedded").toString() else json
    val live = options.optString("mode") == "continuous" && options.optBoolean("echoCancellation")
    val capture = Capture(context, live) { pcm ->
      executor.execute { if (!held) emit(core.pushPcm16(pcm)) }
    }
    capture.onInterrupted = { reason ->
      stopCapture()
      emit(JSONObject().put("event", "interrupted").put("reason", reason))
    }
    val diagnostics = options.optBoolean("diagnostics")
    if (diagnostics) {
      capture.onRouteChange = { emit(JSONObject().put("event", "input").put("input", JSONObject(capture.input()))) }
    }
    onQueue {
      held = false
      core.listen(listenJson, Capture.RATE_UNSIGNED, recognizer)
    }
    capture.start()
    this.capture = capture
    if (diagnostics) emit(JSONObject().put("event", "input").put("input", JSONObject(capture.input())))
    if (live) emit(JSONObject().put("event", "echoCancellation").put("available", capture.echoCancelled))
  }

  private fun osRecognizer(language: String): AndroidRecognizer {
    if (AndroidRecognizer.support(context, language) != "ready") {
      throw CodedException("NoRecognizer", "This device has no recognizer on board for $language", null)
    }
    return AndroidRecognizer(context)
  }

  /** An utterance's id as the core takes it – kept out of Expo's DSL, which Kotlin's compiler trips over. */
  private fun utterance(id: Int): UInt = id.toUInt()

  private fun stopCapture() {
    capture?.stop()
    capture = null
  }

  private fun <T> onQueue(work: () -> T): T =
    try {
      executor.submit(Callable { work() }).get()
    } catch (error: ExecutionException) {
      throw error.cause ?: error
    }

  private fun emit(json: String) {
    if (json != "[]") sendEvent("onPortEvent", mapOf("json" to json))
  }

  private fun emit(event: JSONObject) {
    sendEvent("onPortEvent", mapOf("json" to JSONArray().put(event).toString()))
  }
}
