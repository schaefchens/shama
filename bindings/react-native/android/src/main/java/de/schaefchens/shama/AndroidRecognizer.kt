package de.schaefchens.shama

import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
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
 * once – and answers with its readings, favoring the app's phrases. Called on Shama's thread, it
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
    var answer: String? = null
    var failure: String? = null
    val pipe = ParcelFileDescriptor.createPipe()
    var recognizer: SpeechRecognizer? = null
    main.post {
      recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context).apply {
        setRecognitionListener(object : RecognitionListener {
          override fun onResults(results: Bundle) {
            answer = readings(results)
            heard.countDown()
          }

          override fun onError(error: Int) {
            if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) answer = "[]"
            else failure = "the recognizer failed ($error)"
            heard.countDown()
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
          putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pipe[0])
          putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
          putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
          putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, Capture.RATE)
        })
      }
    }
    // The utterance into the pipe, then its end: the recognizer hears it through.
    val writer = Thread({
      runCatching { ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]).use { it.write(audio) } }
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
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_WEB_SEARCH)
      putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale(language))
      putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5)
      putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
    }

    /** The readings as JSON, with the recognizer's confidence where it gives one. */
    private fun readings(results: Bundle): String {
      val texts = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
      val confidences = results.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES)
      val array = JSONArray()
      texts.forEachIndexed { i, text ->
        val reading = JSONObject().put("text", text)
        val confidence = confidences?.getOrNull(i)
        if (confidence != null && confidence >= 0) reading.put("confidence", confidence.toDouble())
        array.put(reading)
      }
      return array.toString()
    }

    /** "ready", "downloadable" – the language is there, its model not yet – or "unsupported". */
    fun support(context: Context, language: String): String {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || !SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) {
        return "unsupported"
      }
      val checked = CountDownLatch(1)
      var support = "unsupported"
      val main = Handler(Looper.getMainLooper())
      main.post {
        val recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
        val wanted = locale(language).lowercase()
        recognizer.checkRecognitionSupport(intent(language), Executor { it.run() }, object : RecognitionSupportCallback {
          override fun onSupportResult(result: RecognitionSupport) {
            val has = { list: List<String> -> list.any { it.lowercase() == wanted || it.lowercase().startsWith("$language-") } }
            support = when {
              has(result.installedOnDeviceLanguages) -> "ready"
              has(result.supportedOnDeviceLanguages) || has(result.pendingOnDeviceLanguages) -> "downloadable"
              else -> "unsupported"
            }
            recognizer.destroy()
            checked.countDown()
          }

          override fun onError(error: Int) {
            recognizer.destroy()
            checked.countDown()
          }
        })
      }
      checked.await(3, TimeUnit.SECONDS)
      return support
    }
  }
}
