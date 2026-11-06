// The microphone in the page: a stream at the device's rate – a 16 kHz AudioContext can't take a
// microphone in every browser – through an AudioWorklet whose pieces go to the worker unopened.

import type { InputInfo } from '@schaefchens/shama';

export interface Capture {
  rate: number;
  /** Whether the browser takes the page's own sound out of the microphone. */
  echoCancellation: boolean;
  /** The microphone as the browser tells of it. */
  input: InputInfo;
  /** Called when the microphone goes away – unplugged, or taken by the system. */
  onEnded?: () => void;
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
  const track = stream.getAudioTracks()[0];
  const settings = track?.getSettings() ?? {};
  const on = (value: unknown) => (value === true ? 'on' : value === false ? 'off' : 'unknown');
  const details: Record<string, string | number | boolean> = {};
  if (typeof settings.sampleRate === 'number') details['microphone rate'] = settings.sampleRate;
  if (typeof (settings as { latency?: number }).latency === 'number') {
    details['input latency ms'] = Math.round((settings as { latency: number }).latency * 1000);
  }
  details['base latency ms'] = Math.round(context.baseLatency * 1000);
  const capture: Capture = {
    rate: context.sampleRate,
    echoCancellation: settings.echoCancellation === true,
    input: {
      device: track?.label || 'microphone',
      kind: 'other',
      rate: context.sampleRate,
      channels: settings.channelCount ?? 1,
      processing: `echoCancellation ${on(settings.echoCancellation)} · noiseSuppression ${on(settings.noiseSuppression)} · autoGainControl ${on(settings.autoGainControl)}`,
      echoCancellation: settings.echoCancellation === true,
      details,
    },
    port: channel.port2,
    stop() {
      node.port.postMessage({ close: true });
      source.disconnect();
      node.disconnect();
      silence.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void context.close();
    },
  };
  if (track) track.onended = () => capture.onEnded?.();
  return capture;
}
