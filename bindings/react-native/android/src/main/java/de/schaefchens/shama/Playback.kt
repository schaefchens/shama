package de.schaefchens.shama

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack

/** Utterances' audio kept for debugging, played back at media volume: 16 kHz, 16-bit, one channel. */
class Playback {
  private var track: AudioTrack? = null
  private var done: (() -> Unit)? = null

  @Synchronized
  fun play(pcm: ByteArray, done: () -> Unit) {
    stop()
    val track = AudioTrack.Builder()
      .setAudioAttributes(
        AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
      )
      .setAudioFormat(
        AudioFormat.Builder().setSampleRate(RATE).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build()
      )
      .setTransferMode(AudioTrack.MODE_STATIC)
      .setBufferSizeInBytes(maxOf(pcm.size, 2))
      .build()
    track.write(pcm, 0, pcm.size)
    pcm.fill(0)
    track.notificationMarkerPosition = maxOf(pcm.size / 2 - 1, 1)
    track.setPlaybackPositionUpdateListener(object : AudioTrack.OnPlaybackPositionUpdateListener {
      override fun onMarkerReached(played: AudioTrack) = stop()
      override fun onPeriodicNotification(played: AudioTrack) {}
    })
    this.track = track
    this.done = done
    track.play()
  }

  @Synchronized
  fun stop() {
    track?.run {
      runCatching { stop() }
      release()
    }
    track = null
    done?.invoke()
    done = null
  }

  private companion object {
    const val RATE = 16_000
  }
}
