//! Runs one embedded recognizer over the measuring corpus of one language and writes what it
//! heard, utterance by utterance, with the time each decode took.
//!
//!   shama-bench <model> <lang> [kinds] [threads]
//!
//! `model` names an entry of models.json (paths relative to shama/.cache/models); `kinds` is a
//! comma list of the corpus kinds to run (command,near,oov,fleurs,noise,variant – default all).
//! Output: shama/.cache/runs/<model>/<lang>.jsonl, and a summary line on stdout.
use serde::Deserialize;
use serde_json::{Value, json};
use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OnlineRecognizer, OnlineRecognizerConfig, Wave};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Deserialize, Clone)]
struct Model {
    family: String,
    dir: String,
    #[serde(default)]
    files: BTreeMap<String, String>,
    #[serde(default)]
    language: Option<String>,
}

fn path(dir: &Path, model: &Model, key: &str) -> Option<String> {
    model.files.get(key).map(|file| dir.join(file).to_string_lossy().into_owned())
}

enum Recognizer {
    Offline(OfflineRecognizer),
    Online(OnlineRecognizer),
}

impl Recognizer {
    fn create(model: &Model, models: &Path, lang: &str, threads: i32) -> Recognizer {
        let dir = models.join(&model.dir);
        if model.family == "online_transducer" {
            let mut config = OnlineRecognizerConfig::default();
            config.model_config.transducer.encoder = path(&dir, model, "encoder");
            config.model_config.transducer.decoder = path(&dir, model, "decoder");
            config.model_config.transducer.joiner = path(&dir, model, "joiner");
            config.model_config.tokens = path(&dir, model, "tokens");
            config.model_config.num_threads = threads;
            config.decoding_method = Some("greedy_search".into());
            return Recognizer::Online(OnlineRecognizer::create(&config).expect("online recognizer"));
        }
        let mut config = OfflineRecognizerConfig::default();
        let m = &mut config.model_config;
        m.tokens = path(&dir, model, "tokens");
        m.num_threads = threads;
        match model.family.as_str() {
            "nemo_ctc" => m.nemo_ctc.model = path(&dir, model, "model"),
            "dolphin" => m.dolphin.model = path(&dir, model, "model"),
            "omnilingual" => m.omnilingual.model = path(&dir, model, "model"),
            "zipformer_ctc" => m.zipformer_ctc.model = path(&dir, model, "model"),
            "transducer" | "nemo_transducer" => {
                m.transducer.encoder = path(&dir, model, "encoder");
                m.transducer.decoder = path(&dir, model, "decoder");
                m.transducer.joiner = path(&dir, model, "joiner");
                if model.family == "nemo_transducer" {
                    m.model_type = Some("nemo_transducer".into());
                }
            }
            "whisper" => {
                m.whisper.encoder = path(&dir, model, "encoder");
                m.whisper.decoder = path(&dir, model, "decoder");
                m.whisper.language = Some(model.language.clone().unwrap_or_else(|| lang.to_string()));
                m.whisper.task = Some("transcribe".into());
                m.whisper.tail_paddings = -1;
            }
            "moonshine" => {
                m.moonshine.preprocessor = path(&dir, model, "preprocessor");
                m.moonshine.encoder = path(&dir, model, "encoder");
                m.moonshine.uncached_decoder = path(&dir, model, "uncached_decoder");
                m.moonshine.cached_decoder = path(&dir, model, "cached_decoder");
                m.moonshine.merged_decoder = path(&dir, model, "merged_decoder");
            }
            other => panic!("unknown family {other}"),
        }
        Recognizer::Offline(OfflineRecognizer::create(&config).expect("offline recognizer"))
    }

    fn recognize(&self, samples: &[f32]) -> String {
        match self {
            Recognizer::Offline(recognizer) => {
                let stream = recognizer.create_stream();
                stream.accept_waveform(16000, samples);
                recognizer.decode(&stream);
                stream.get_result().map(|r| r.text).unwrap_or_default()
            }
            Recognizer::Online(recognizer) => {
                let stream = recognizer.create_stream();
                stream.accept_waveform(16000, samples);
                // Trailing silence lets the streaming model emit its last tokens.
                stream.accept_waveform(16000, &[0.0; 8000]);
                stream.input_finished();
                while recognizer.is_ready(&stream) {
                    recognizer.decode(&stream);
                }
                recognizer.get_result(&stream).map(|r| r.text).unwrap_or_default()
            }
        }
    }
}

fn max_rss_mb() -> f64 {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    // Bytes on macOS, kilobytes on Linux and Android.
    let rss = usage.ru_maxrss as f64;
    if cfg!(target_os = "macos") { rss / 1e6 } else { rss / 1e3 }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (name, lang) = (&args[1], &args[2]);
    let kinds: Vec<String> =
        args.get(3).map(|k| k.split(',').filter(|k| !k.is_empty()).map(String::from).collect()).unwrap_or_default();
    let threads: i32 = args.get(4).map(|t| t.parse().unwrap()).unwrap_or(2);
    let root = PathBuf::from(std::env::var("SHAMA_ROOT").unwrap_or_else(|_| "../..".into()));
    let models_file = root.join("tools/bench/models.json");
    let registry: BTreeMap<String, Model> =
        serde_json::from_str(&fs::read_to_string(&models_file).expect("models.json")).expect("models.json parses");
    let model = registry.get(name).unwrap_or_else(|| panic!("no model {name} in models.json")).clone();
    let models = root.join(".cache/models");

    let corpus = root.join(".cache/corpus").join(lang);
    let mut entries: Vec<Value> = Vec::new();
    for manifest in ["manifest.jsonl", "fleurs.jsonl", "noise.jsonl", "variants.jsonl"] {
        let Ok(text) = fs::read_to_string(corpus.join(manifest)) else { continue };
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let entry: Value = serde_json::from_str(line).expect("manifest line");
            let kind = entry["kind"].as_str().unwrap_or_default().to_string();
            if kinds.is_empty() || kinds.contains(&kind) {
                entries.push(entry);
            }
        }
    }

    let started = Instant::now();
    let recognizer = Recognizer::create(&model, &models, lang, threads);
    let load_ms = started.elapsed().as_secs_f64() * 1000.0;

    let out_dir = root.join(".cache/runs").join(name);
    fs::create_dir_all(&out_dir).unwrap();
    let suffix = if kinds.is_empty() { String::new() } else { format!("-{}", kinds.join("+")) };
    let mut out = fs::File::create(out_dir.join(format!("{lang}{suffix}.jsonl"))).unwrap();
    let (mut audio_total, mut decode_total) = (0.0, 0.0);
    let mut decodes: Vec<f64> = Vec::new();
    for entry in &entries {
        let file = root.join(entry["file"].as_str().unwrap());
        let wave = Wave::read(file.to_str().unwrap()).unwrap_or_else(|| panic!("reads {}", file.display()));
        assert_eq!(wave.sample_rate(), 16000, "{}", file.display());
        let audio_ms = wave.samples().len() as f64 / 16.0;
        // The silence Shama's endpointer keeps around speech: 300 ms before, 400 ms after.
        let mut samples = vec![0.0f32; 4800];
        samples.extend_from_slice(wave.samples());
        samples.extend(std::iter::repeat_n(0.0f32, 6400));
        let t = Instant::now();
        let text = recognizer.recognize(&samples);
        let decode_ms = t.elapsed().as_secs_f64() * 1000.0;
        audio_total += audio_ms;
        decode_total += decode_ms;
        decodes.push(decode_ms);
        let line = json!({
            "id": entry["id"], "kind": entry["kind"], "voice": entry["voice"], "expected": entry["expected"],
            "hypotheses": [{ "text": text.trim() }], "decode_ms": (decode_ms * 10.0).round() / 10.0, "audio_ms": audio_ms.round(),
        });
        writeln!(out, "{line}").unwrap();
    }
    decodes.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let quantile = |q: f64| decodes.get(((decodes.len() as f64 - 1.0) * q).round() as usize).copied().unwrap_or(0.0);
    println!(
        "{}",
        json!({
            "model": name, "lang": lang, "utterances": entries.len(), "threads": threads,
            "load_ms": load_ms.round(), "rtf": if audio_total > 0.0 { (decode_total / audio_total * 1000.0).round() / 1000.0 } else { 0.0 },
            "decode_p50_ms": quantile(0.5).round(), "decode_p95_ms": quantile(0.95).round(), "max_rss_mb": max_rss_mb().round(),
        })
    );
}
