package de.schaefchens.shama

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.os.Build

/**
 * The microphone, through AudioRecord, at 16 kHz – the rate the recognizers take, which every
 * Android device records at.
 *
 * Push-to-talk records as recognizers want it (VOICE_RECOGNITION) and takes the audio focus for
 * the moment, as speech recognition does. LIVE shares the sound – the app reads aloud meanwhile –
 * and records with the platform's echo canceller where the device has one.
 */
class Capture(private val context: Context, private val live: Boolean, private val onAudio: (ByteArray) -> Unit) {
  private var record: AudioRecord? = null
  private var echo: AcousticEchoCanceler? = null
  private var thread: Thread? = null
  private var focus: AudioFocusRequest? = null
  @Volatile private var running = false
  var onInterrupted: ((String) -> Unit)? = null
  var echoCancelled = false
    private set

  @SuppressLint("MissingPermission")
  fun start(): Int {
    val source = if (live) MediaRecorder.AudioSource.VOICE_COMMUNICATION else MediaRecorder.AudioSource.VOICE_RECOGNITION
    val minimum = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    val record = AudioRecord(source, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minimum, RATE / 5 * 2) * 2)
    if (record.state != AudioRecord.STATE_INITIALIZED) {
      record.release()
      throw IllegalStateException("the microphone isn't available")
    }
    if (live && AcousticEchoCanceler.isAvailable()) {
      echo = AcousticEchoCanceler.create(record.audioSessionId)?.apply { enabled = true }
      echoCancelled = echo?.enabled == true
    }
    if (!live) requestFocus()
    record.startRecording()
    this.record = record
    running = true
    thread = Thread({
      val buffer = ByteArray(RATE / 10 * 2)
      while (running) {
        val read = record.read(buffer, 0, buffer.size)
        when {
          read > 0 -> onAudio(buffer.copyOf(read))
          read < 0 -> {
            if (running) onInterrupted?.invoke("microphone")
            break
          }
        }
      }
      buffer.fill(0)
    }, "shama-capture").apply { start() }
    return RATE
  }

  /** Stops listening, and gives the audio focus back. */
  fun stop() {
    running = false
    thread?.join(500)
    thread = null
    record?.run {
      runCatching { stop() }
      release()
    }
    record = null
    echo?.release()
    echo = null
    abandonFocus()
  }

  private fun requestFocus() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(AudioManager::class.java) ?: return
    val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_ASSISTANT)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      )
      .setOnAudioFocusChangeListener { change -> if (change < 0 && running) onInterrupted?.invoke("focus") }
      .build()
    manager.requestAudioFocus(request)
    focus = request
  }

  private fun abandonFocus() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val request = focus ?: return
    context.getSystemService(AudioManager::class.java)?.abandonAudioFocusRequest(request)
    focus = null
  }

  companion object {
    const val RATE = 16_000
  }
}
