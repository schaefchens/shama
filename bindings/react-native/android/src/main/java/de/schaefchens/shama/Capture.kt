package de.schaefchens.shama

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRouting
import android.media.MediaRecorder
import android.media.MicrophoneInfo
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Handler
import android.os.Looper

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
  /** The route changed: another microphone, a headset plugged in or out. */
  var onRouteChange: (() -> Unit)? = null
  var echoCancelled = false
    private set
  private val source = if (live) MediaRecorder.AudioSource.VOICE_COMMUNICATION else MediaRecorder.AudioSource.VOICE_RECOGNITION
  private var bufferBytes = 0
  private var routing: AudioRouting.OnRoutingChangedListener? = null

  @SuppressLint("MissingPermission")
  fun start(): Int {
    val minimum = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    bufferBytes = maxOf(minimum, RATE / 5 * 2) * 2
    val record = AudioRecord(source, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufferBytes)
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
    // The device is known once routing settles – and told again whenever it changes.
    routing = AudioRouting.OnRoutingChangedListener { onRouteChange?.invoke() }.also {
      record.addOnRoutingChangedListener(it, Handler(Looper.getMainLooper()))
    }
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
      routing?.let { removeOnRoutingChangedListener(it) }
      runCatching { stop() }
      release()
    }
    routing = null
    record = null
    echo?.release()
    echo = null
    abandonFocus()
  }

  /** The microphone as the system tells of it, for diagnostics. */
  fun input(): Map<String, Any> {
    val record = record ?: return emptyMap()
    val device = record.routedDevice
    val details = mutableMapOf<String, Any>(
      "buffer ms" to bufferBytes / 2 * 1000 / RATE,
      "echo canceller available" to AcousticEchoCanceler.isAvailable(),
      "noise suppressor available" to NoiseSuppressor.isAvailable(),
      "gain control available" to AutomaticGainControl.isAvailable(),
    )
    device?.let { details["device type"] = typeName(it.type) }
    context.getSystemService(AudioManager::class.java)?.let { manager ->
      details["microphone muted"] = manager.isMicrophoneMute
      details["audio mode"] = when (manager.mode) {
        AudioManager.MODE_IN_CALL -> "in call"
        AudioManager.MODE_IN_COMMUNICATION -> "in communication"
        AudioManager.MODE_RINGTONE -> "ringtone"
        else -> "normal"
      }
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      record.activeRecordingConfiguration?.let { details["silenced by the system"] = it.isClientSilenced }
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      runCatching { record.activeMicrophones.firstOrNull() }.getOrNull()?.let { microphone ->
        details["microphone"] = microphone.description
        details["microphone location"] = when (microphone.location) {
          MicrophoneInfo.LOCATION_MAINBODY -> "main body"
          MicrophoneInfo.LOCATION_MAINBODY_MOVABLE -> "main body, movable"
          MicrophoneInfo.LOCATION_PERIPHERAL -> "peripheral"
          else -> "unknown"
        }
      }
    }
    return mapOf(
      "device" to (device?.productName?.toString()?.takeIf { it.isNotBlank() } ?: "microphone"),
      "kind" to kind(device?.type),
      "rate" to record.sampleRate,
      "channels" to record.channelCount,
      "processing" to if (live) "VOICE_COMMUNICATION" else "VOICE_RECOGNITION",
      "echoCancellation" to echoCancelled,
      "details" to details,
    )
  }

  private fun kind(type: Int?): String = when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_MIC -> "builtIn"
    AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_LINE_ANALOG, AudioDeviceInfo.TYPE_LINE_DIGITAL -> "wired"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> "bluetooth"
    AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_ACCESSORY -> "usb"
    else -> "other"
  }

  private fun typeName(type: Int): String = when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_MIC -> "built-in microphone"
    AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired headset"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "Bluetooth SCO"
    AudioDeviceInfo.TYPE_BLE_HEADSET -> "Bluetooth LE headset"
    AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_ACCESSORY -> "USB"
    AudioDeviceInfo.TYPE_TELEPHONY -> "telephony"
    AudioDeviceInfo.TYPE_REMOTE_SUBMIX -> "remote submix"
    else -> "type $type"
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
    /** The rate as the core takes it: written out, as Kotlin's compiler fails folding `RATE.toUInt()`. */
    val RATE_UNSIGNED: UInt = 16_000u
  }
}
