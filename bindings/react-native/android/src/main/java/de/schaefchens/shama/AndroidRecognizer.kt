package de.schaefchens.shama

import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import de.schaefchens.shama.core.PlatformRecognizer
import de.schaefchens.shama.core.RecognizerException
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit

/**
 * Android's recognizer, held on the device: `createOnDeviceSpeechRecognizer` (API 33 and later),
 * never one that may stream to servers. It hears Shama's audio through a pipe – the utterance at
 * once – and answers with its reading, favoring the app's phrases. Called on Shama's thread, it
 * waits there until it has heard.
 */
class AndroidRecognizer(private val context: Context) : PlatformRecognizer {
  private val main = Handler(Looper.getMainLooper())

  override fun name(): String = "os:android"

  override fun recognize(language: String, bias: List<String>, audio: ByteArray): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || !SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) {
      throw RecognizerException.Failed("no recognizer on board")
    }
    val heard = CountDownLatch(1)
    val segments = mutableListOf<String>()
    var answer: String? = null
    var failure: String? = null
    val pipe = ParcelFileDescriptor.createPipe()
    var recognizer: SpeechRecognizer? = null
    val finish = { result: String? ->
      if (heard.count > 0) {
        answer = result
        heard.countDown()
      }
    }
    main.post {
      recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context).apply {
        setRecognitionListener(object : RecognitionListener {
          // Fed from a pipe, Google's recognizer hears in a segmented session: each segment's
          // reading comes here, and the final onResults stays empty.
          override fun onSegmentResults(segment: Bundle) {
            segment.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let { segments += it }
          }

          override fun onEndOfSegmentedSession() = finish(joined(segments))

          override fun onResults(results: Bundle) = finish(readings(results) ?: joined(segments))

          override fun onError(error: Int) {
            if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
              finish(joined(segments))
            } else {
              failure = "the recognizer failed ($error)"
              finish(null)
            }
          }

          override fun onReadyForSpeech(params: Bundle?) {}
          override fun onBeginningOfSpeech() {}
          override fun onRmsChanged(rmsdB: Float) {}
          override fun onBufferReceived(buffer: ByteArray?) {}
          override fun onEndOfSpeech() {}
          override fun onPartialResults(partialResults: Bundle?) {}
          override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        startListening(intent(language).apply {
          putStringArrayListExtra(RecognizerIntent.EXTRA_BIASING_STRINGS, ArrayList(bias.take(500)))
          putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE)
          putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pipe[0])
          putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
          putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
          putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, Capture.RATE)
        })
      }
    }
    // The utterance into the pipe, a moment of silence that closes its last segment, then the
    // pipe's end, which ends the session.
    val writer = Thread({
      runCatching {
        ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]).use {
          it.write(audio)
          it.write(ByteArray(Capture.RATE)) // 0.5 s
        }
      }
    }, "shama-recognizer-audio").apply { start() }
    val done = heard.await(10, TimeUnit.SECONDS)
    main.post { recognizer?.destroy() }
    runCatching { pipe[1].close() }
    writer.join(500)
    runCatching { pipe[0].close() }
    if (!done) throw RecognizerException.Failed("the recognizer took too long")
    failure?.let { throw RecognizerException.Failed(it) }
    return answer ?: "[]"
  }

  companion object {
    fun locale(language: String): String =
      mapOf("en" to "en-US", "de" to "de-DE", "tr" to "tr-TR", "ar" to "ar-SA", "fa" to "fa-IR")[language] ?: language

    private fun intent(language: String) = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale(language))
      putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5)
      putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
    }

    /** A segmented session's reading: one, without a confidence (Google's is always 0 there). */
    private fun joined(segments: List<String>): String {
      val text = segments.joinToString(" ").trim()
      return if (text.isEmpty()) "[]" else JSONArray().put(JSONObject().put("text", text)).toString()
    }

    /** The readings as JSON, with the recognizer's confidence where it gives one; null for none. */
    private fun readings(results: Bundle): String? {
      val texts = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
      val confidences = results.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES)
      val array = JSONArray()
      texts.forEachIndexed { i, text ->
        if (text.isBlank()) return@forEachIndexed
        val reading = JSONObject().put("text", text)
        val confidence = confidences?.getOrNull(i)
        if (confidence != null && confidence >= 0) reading.put("confidence", confidence.toDouble())
        array.put(reading)
      }
      return if (array.length() == 0) null else array.toString()
    }

    private class Listed(val installed: List<String>, val available: List<String>, val at: Long)

    /** The service's languages, asked once for all of them and kept a minute: asked again and again, it says no. */
    @Volatile private var listed: Listed? = null

    /** "ready", "downloadable" – the language is there, its model not yet – or "unsupported". */
    fun support(context: Context, language: String): String {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || !SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) {
        return "unsupported"
      }
      val languages = languages(context) ?: return "unsupported"
      val wanted = locale(language).lowercase()
      val has = { list: List<String> -> list.any { it.lowercase() == wanted || it.lowercase().startsWith("$language-") } }
      return when {
        has(languages.installed) -> "ready"
        has(languages.available) -> "downloadable"
        else -> "unsupported"
      }
    }

    private fun languages(context: Context): Listed? {
      listed?.takeIf { SystemClock.elapsedRealtime() - it.at < 60_000 }?.let { return it }
      val checked = CountDownLatch(1)
      val main = Handler(Looper.getMainLooper())
      main.post {
        val recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
        val done = {
          main.post { recognizer.destroy() }
          checked.countDown()
        }
        recognizer.checkRecognitionSupport(intent("en"), Executor { it.run() }, object : RecognitionSupportCallback {
          override fun onSupportResult(result: RecognitionSupport) {
            listed = Listed(
              result.installedOnDeviceLanguages,
              result.supportedOnDeviceLanguages + result.pendingOnDeviceLanguages,
              SystemClock.elapsedRealtime(),
            )
            done()
          }

          override fun onError(error: Int) = done()
        })
      }
      checked.await(3, TimeUnit.SECONDS)
      // On a failed check, what was known before.
      return listed
    }
  }
}
