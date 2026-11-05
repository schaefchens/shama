// Takes the microphone's audio off the audio thread in pieces of about 20 ms, at the device's
// rate, mixed to one channel – straight to Shama's worker through the port it is given, never
// through the page.
class ShamaCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.out = null;
    this.piece = new Float32Array(Math.round(sampleRate / 50));
    this.filled = 0;
    this.port.onmessage = (event) => {
      if (event.data && event.data.port) this.out = event.data.port;
      if (event.data && event.data.close) this.out = null;
    };
  }

  process(inputs) {
    const channels = inputs[0];
    if (!this.out || !channels || channels.length === 0) return true;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (const channel of channels) sum += channel[i];
      this.piece[this.filled++] = sum / channels.length;
      if (this.filled === this.piece.length) {
        this.out.postMessage(this.piece, [this.piece.buffer]);
        this.piece = new Float32Array(this.piece.length);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('shama-capture', ShamaCapture);
