package de.schaefchens.shama

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * Shama's own voice, for its replies in LIVE: a voice on the device – a network voice would send
 * the text away.
 */
class Speaker(context: Context) {
  private val waiting = ConcurrentHashMap<String, () -> Unit>()
  private var ready = false
  private var next = 0
  private val engine: TextToSpeech = TextToSpeech(context.applicationContext) { status -> ready = status == TextToSpeech.SUCCESS }

  init {
    engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(utteranceId: String) {}
      override fun onDone(utteranceId: String) {
        waiting.remove(utteranceId)?.invoke()
      }

      @Deprecated("Deprecated in Java")
      override fun onError(utteranceId: String) {
        waiting.remove(utteranceId)?.invoke()
      }

      override fun onStop(utteranceId: String, interrupted: Boolean) {
        waiting.remove(utteranceId)?.invoke()
      }
    })
  }

  fun speak(text: String, language: String, done: () -> Unit) {
    val locale = Locale.forLanguageTag(AndroidRecognizer.locale(language))
    val voice: Voice? = runCatching {
      engine.voices?.firstOrNull { !it.isNetworkConnectionRequired && it.locale.language == locale.language }
    }.getOrNull()
    if (!ready || voice == null) {
      done()
      return
    }
    engine.voice = voice
    val id = "shama-${next++}"
    waiting[id] = done
    if (engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) waiting.remove(id)?.invoke()
  }

  fun stop() {
    engine.stop()
    waiting.keys.toList().forEach { waiting.remove(it)?.invoke() }
  }

  fun shutdown() {
    engine.shutdown()
  }
}
