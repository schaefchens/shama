// The microphone in the page: a stream at the device's rate – a 16 kHz AudioContext can't take a
// microphone in every browser – through an AudioWorklet whose pieces go to the worker unopened.

export interface Capture {
  rate: number;
  /** Whether the browser takes the page's own sound out of the microphone. */
  echoCancellation: boolean;
  /** Where the worklet's audio arrives – handed to the worker. */
  port: MessagePort;
  stop(): void;
}

export async function startCapture(options: { echoCancellation: boolean }): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: options.echoCancellation,
      // Recognizers do better with the voice as it is.
      noiseSuppression: false,
      autoGainControl: true,
    },
  });
  const context = new AudioContext();
  try {
    await context.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    await context.close();
    throw error;
  }
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, 'shama-capture', { numberOfInputs: 1, numberOfOutputs: 1 });
  // Pulled through a silent output, so every browser runs the worklet.
  const silence = context.createGain();
  silence.gain.value = 0;
  const channel = new MessageChannel();
  node.port.postMessage({ port: channel.port1 }, [channel.port1]);
  source.connect(node).connect(silence).connect(context.destination);
  if (context.state === 'suspended') await context.resume();
  const settings = stream.getAudioTracks()[0]?.getSettings();
  return {
    rate: context.sampleRate,
    echoCancellation: settings?.echoCancellation === true,
    port: channel.port2,
    stop() {
      node.port.postMessage({ close: true });
      source.disconnect();
      node.disconnect();
      silence.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void context.close();
    },
  };
}
