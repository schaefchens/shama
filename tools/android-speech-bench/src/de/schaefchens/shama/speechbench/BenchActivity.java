package de.schaefchens.shama.speechbench;

import android.app.Activity;
import android.content.Intent;
import android.media.AudioFormat;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.speech.RecognitionListener;
import android.speech.RecognitionSupport;
import android.speech.RecognitionSupportCallback;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Log;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Measures Android's on-device speech recognizer for Shama, driven by adb:
 *
 *   am start -n de.schaefchens.shama.speechbench/.BenchActivity --es cmd probe
 *   am start -n ... --es cmd run --es lang de-DE --es dir files/de [--es bias "a|b"] [--ez realtime true]
 *
 * Audio files are raw 16 kHz 16-bit mono PCM (*.pcm). Every finding is a JSON line under the log tag ShamaBench; run also writes them to
 * files/results.jsonl in the app's own storage. Audio goes to the recognizer through a pipe
 * (EXTRA_AUDIO_SOURCE), never through the microphone.
 */
public class BenchActivity extends Activity {
    private static final String TAG = "ShamaBench";
    private final Handler main = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private OutputStream results;

    private void emit(JSONObject json) {
        Log.i(TAG, json.toString());
        if (results != null) {
            try {
                results.write((json + "\n").getBytes("UTF-8"));
                results.flush();
            } catch (IOException ignored) {
            }
        }
    }

    private static JSONObject json(Object... pairs) {
        JSONObject json = new JSONObject();
        try {
            for (int i = 0; i < pairs.length; i += 2) json.put((String) pairs[i], pairs[i + 1]);
        } catch (Exception ignored) {
        }
        return json;
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        handle(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handle(intent);
    }

    private void handle(Intent intent) {
        String cmd = intent.getStringExtra("cmd");
        boolean available = SpeechRecognizer.isOnDeviceRecognitionAvailable(this);
        emit(json("event", "start", "cmd", cmd, "onDeviceAvailable", available));
        if (!available) return;
        if (recognizer != null) recognizer.destroy();
        recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(this);
        if ("probe".equals(cmd)) probe(intent.getStringExtra("download"));
        else if ("run".equals(cmd)) run(intent);
    }

    private void probe(String download) {
        for (String tag : Arrays.asList("en-US", "de-DE", "tr-TR", "ar-SA", "fa-IR")) {
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, tag);
            recognizer.checkRecognitionSupport(intent, getMainExecutor(), new RecognitionSupportCallback() {
                @Override
                public void onSupportResult(RecognitionSupport support) {
                    emit(json("event", "support", "lang", tag,
                            "installed", new JSONArray(support.getInstalledOnDeviceLanguages()),
                            "pending", new JSONArray(support.getPendingOnDeviceLanguages()),
                            "supported", new JSONArray(support.getSupportedOnDeviceLanguages()),
                            "online", new JSONArray(support.getOnlineLanguages())));
                    if (tag.equals(download)) {
                        recognizer.triggerModelDownload(intent);
                        emit(json("event", "download", "lang", tag));
                    }
                }

                @Override
                public void onError(int error) {
                    emit(json("event", "supportError", "lang", tag, "error", error));
                }
            });
        }
    }

    private void run(Intent command) {
        String lang = command.getStringExtra("lang");
        File dir = new File(getFilesDir(), command.getStringExtra("dir").replaceFirst("^files/", ""));
        String bias = command.getStringExtra("bias");
        boolean realtime = command.getBooleanExtra("realtime", true);
        File[] wavs = dir.listFiles((d, name) -> name.endsWith(".pcm"));
        if (wavs == null) wavs = new File[0];
        Arrays.sort(wavs);
        try {
            results = new FileOutputStream(new File(getFilesDir(), "results.jsonl"), true);
        } catch (IOException e) {
            emit(json("event", "error", "message", e.toString()));
        }
        List<File> queue = new ArrayList<>(Arrays.asList(wavs));
        emit(json("event", "run", "lang", lang, "files", queue.size(), "bias", bias != null));
        next(queue, lang, bias, realtime);
    }

    private void next(List<File> queue, String lang, String bias, boolean realtime) {
        if (queue.isEmpty()) {
            emit(json("event", "done"));
            return;
        }
        File wav = queue.remove(0);
        boolean[] settled = {false};
        Runnable onward = () -> {
            if (settled[0]) return;
            settled[0] = true;
            main.postDelayed(() -> next(queue, lang, bias, realtime), 200);
        };
        main.postDelayed(() -> {
            if (settled[0]) return;
            emit(json("event", "result", "id", wav.getName().replace(".pcm", ""), "hypotheses", new JSONArray(), "error", "timeout"));
            recognizer.cancel();
            onward.run();
        }, 30000);
        try {
            ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5);
            intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            // A segmented session lasting as long as the audio source: the service then hands each
            // segment's hearing to onSegmentResults (its final onResults stays empty).
            intent.putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE);
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pipe[0]);
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, 16000);
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1);
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT);
            if (bias != null) intent.putStringArrayListExtra(RecognizerIntent.EXTRA_BIASING_STRINGS, new ArrayList<>(Arrays.asList(bias.split("\\|"))));
            long[] ended = {0};
            long[] speechEnded = {0};
            long[] lastSegmentAt = {0};
            String[] lastPartial = {null};
            List<String> segments = new ArrayList<>();
            List<Float> segmentScores = new ArrayList<>();
            String id = wav.getName().replace(".pcm", "");
            recognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) {}
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float rms) {}
                @Override public void onBufferReceived(byte[] buffer) {}
                @Override public void onEndOfSpeech() {}
                // With an audio source, Google's on-device service sends its last hearing as partial
                // results and an empty final bundle: keep the last partial as the result.
                @Override public void onPartialResults(Bundle partial) {
                    ArrayList<String> texts = partial.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (texts != null && !texts.isEmpty()) lastPartial[0] = texts.get(0);
                }

                @Override public void onSegmentResults(Bundle segment) {
                    ArrayList<String> texts = segment.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    float[] scores = segment.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES);
                    lastSegmentAt[0] = SystemClock.elapsedRealtime();
                    if (texts != null && !texts.isEmpty()) {
                        segments.add(texts.get(0));
                        segmentScores.add(scores != null && scores.length > 0 ? scores[0] : -1f);
                    }
                }

                @Override public void onEndOfSegmentedSession() {
                    // From the end of the speech (before the trailing silence) to the last segment's hearing.
                    long latency = speechEnded[0] == 0 || lastSegmentAt[0] == 0 ? -1 : lastSegmentAt[0] - speechEnded[0];
                    JSONArray hypotheses = new JSONArray();
                    String text = String.join(" ", segments).trim();
                    float confidence = segmentScores.isEmpty() ? -1f : segmentScores.get(0);
                    hypotheses.put(json("text", text, "confidence", confidence, "segments", segments.size()));
                    emit(json("event", "result", "id", id, "hypotheses", hypotheses, "latency_ms", latency));
                    onward.run();
                }
                @Override public void onEvent(int type, Bundle params) {}

                @Override
                public void onResults(Bundle bundle) {
                    long latency = ended[0] == 0 ? -1 : SystemClock.elapsedRealtime() - ended[0];
                    ArrayList<String> texts = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    float[] scores = bundle.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES);
                    JSONArray hypotheses = new JSONArray();
                    for (int i = 0; texts != null && i < texts.size(); i++) {
                        hypotheses.put(json("text", texts.get(i), "confidence", scores != null && i < scores.length ? scores[i] : -1));
                    }
                    if (hypotheses.length() == 0 && lastPartial[0] != null) hypotheses.put(json("text", lastPartial[0], "partial", true));
                    JSONObject keys = new JSONObject();
                    for (String key : bundle.keySet()) {
                        try {
                            keys.put(key, String.valueOf(bundle.get(key)));
                        } catch (Exception ignored) {
                        }
                    }
                    emit(json("event", "result", "id", id, "hypotheses", hypotheses, "latency_ms", latency, "bundle", keys));
                    onward.run();
                }

                @Override
                public void onError(int error) {
                    long latency = ended[0] == 0 ? -1 : SystemClock.elapsedRealtime() - ended[0];
                    JSONArray hypotheses = new JSONArray();
                    if (lastPartial[0] != null) hypotheses.put(json("text", lastPartial[0], "partial", true));
                    emit(json("event", "result", "id", id, "hypotheses", hypotheses, "error", error, "latency_ms", latency));
                    onward.run();
                }
            });
            recognizer.startListening(intent);
            new Thread(() -> {
                try (FileInputStream in = new FileInputStream(wav);
                     OutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {
                    byte[] chunk = new byte[3200]; // 100 ms
                    int n;
                    while ((n = in.read(chunk)) > 0) {
                        out.write(chunk, 0, n);
                        if (realtime) SystemClock.sleep(100);
                    }
                    speechEnded[0] = SystemClock.elapsedRealtime();
                    // A second of silence lets the recognizer close the utterance.
                    byte[] silence = new byte[3200];
                    for (int i = 0; i < 10; i++) {
                        out.write(silence);
                        if (realtime) SystemClock.sleep(100);
                    }
                } catch (IOException e) {
                    emit(json("event", "pipeError", "id", id, "message", e.toString()));
                }
                ended[0] = SystemClock.elapsedRealtime();
                // Closing the pipe ends the audio; stopListening() here would end the session before
                // the final result and deliver an empty one.
            }).start();
        } catch (IOException e) {
            emit(json("event", "error", "message", e.toString()));
        }
    }

    @Override
    protected void onDestroy() {
        if (recognizer != null) recognizer.destroy();
        super.onDestroy();
    }
}
