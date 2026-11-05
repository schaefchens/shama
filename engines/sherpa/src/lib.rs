//! Shama's embedded recognizer: a speech model run by sherpa-onnx inside the app – for languages
//! the system can't hear on the device, for the web, and for apps that keep audio in their process.
//!
//! A model is a folder with its files and a `shama-model.json` that says what it is:
//!
//! ```json
//! { "id": "fa-rizeh", "language": "fa", "family": "nemo_ctc",
//!   "files": { "model": "model.int8.onnx", "tokens": "tokens.txt" } }
//! ```
//!
//! Loading one takes a second and some hundred MB, so a loaded model is shared: each listen gets a
//! recognizer that borrows it.

use serde::Deserialize;
use shama::engine::Recognizer;
use shama::listen::Utterance;
use shama::{Hypothesis, Language};
use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OnlineRecognizer, OnlineRecognizerConfig};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const MANIFEST: &str = "shama-model.json";

/// What a model folder holds, from its `shama-model.json`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub language: Language,
    /// How sherpa-onnx runs it: nemo_ctc, nemo_transducer, transducer, online_transducer,
    /// zipformer_ctc, moonshine, whisper, dolphin, omnilingual.
    pub family: String,
    /// The family's parts – model, encoder, decoder, joiner, tokens … – by file name.
    pub files: BTreeMap<String, String>,
}

enum Runner {
    Offline(OfflineRecognizer),
    Online(OnlineRecognizer),
}

/// A loaded model.
#[derive(Clone)]
pub struct Model {
    manifest: Arc<Manifest>,
    runner: Arc<Runner>,
}

impl Model {
    /// Loads the model in `folder`, as its `shama-model.json` describes it, decoding on `threads` threads.
    pub fn load(folder: &Path, threads: i32) -> Result<Model, String> {
        let text = std::fs::read_to_string(folder.join(MANIFEST))
            .map_err(|e| format!("{}: {e}", folder.join(MANIFEST).display()))?;
        let manifest: Manifest = serde_json::from_str(&text).map_err(|e| format!("{MANIFEST}: {e}"))?;
        Model::load_as(folder, manifest, threads)
    }

    /// Loads the model in `folder` as `manifest` describes it.
    pub fn load_as(folder: &Path, manifest: Manifest, threads: i32) -> Result<Model, String> {
        let file = |part: &str| -> Result<Option<String>, String> {
            let Some(name) = manifest.files.get(part) else { return Ok(None) };
            let path: PathBuf = folder.join(name);
            if !path.is_file() {
                return Err(format!("{} is missing", path.display()));
            }
            Ok(Some(path.to_string_lossy().into_owned()))
        };
        let need = |part: &str| file(part)?.ok_or_else(|| format!("{MANIFEST} names no {part}"));
        let runner = if manifest.family == "online_transducer" {
            let mut config = OnlineRecognizerConfig::default();
            let m = &mut config.model_config;
            m.transducer.encoder = Some(need("encoder")?);
            m.transducer.decoder = Some(need("decoder")?);
            m.transducer.joiner = Some(need("joiner")?);
            m.tokens = Some(need("tokens")?);
            m.num_threads = threads;
            Runner::Online(OnlineRecognizer::create(&config).ok_or("sherpa-onnx refused the model")?)
        } else {
            let mut config = OfflineRecognizerConfig::default();
            let m = &mut config.model_config;
            m.tokens = Some(need("tokens")?);
            m.num_threads = threads;
            match manifest.family.as_str() {
                "nemo_ctc" => m.nemo_ctc.model = Some(need("model")?),
                "zipformer_ctc" => m.zipformer_ctc.model = Some(need("model")?),
                "dolphin" => m.dolphin.model = Some(need("model")?),
                "omnilingual" => m.omnilingual.model = Some(need("model")?),
                "transducer" | "nemo_transducer" => {
                    m.transducer.encoder = Some(need("encoder")?);
                    m.transducer.decoder = Some(need("decoder")?);
                    m.transducer.joiner = Some(need("joiner")?);
                    if manifest.family == "nemo_transducer" {
                        m.model_type = Some("nemo_transducer".into());
                    }
                }
                "whisper" => {
                    m.whisper.encoder = Some(need("encoder")?);
                    m.whisper.decoder = Some(need("decoder")?);
                    // Told the language: left to guess, it answers short commands in others.
                    m.whisper.language = Some(manifest.language.code().into());
                    m.whisper.task = Some("transcribe".into());
                    m.whisper.tail_paddings = -1;
                }
                "moonshine" => {
                    m.moonshine.preprocessor = file("preprocessor")?;
                    m.moonshine.encoder = Some(need("encoder")?);
                    m.moonshine.uncached_decoder = file("uncached_decoder")?;
                    m.moonshine.cached_decoder = file("cached_decoder")?;
                    m.moonshine.merged_decoder = file("merged_decoder")?;
                }
                other => return Err(format!("unknown model family {other}")),
            }
            Runner::Offline(OfflineRecognizer::create(&config).ok_or("sherpa-onnx refused the model")?)
        };
        Ok(Model { manifest: Arc::new(manifest), runner: Arc::new(runner) })
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    /// The text heard in 16 kHz audio.
    pub fn transcribe(&self, audio: &[f32]) -> String {
        let rate = shama::resample::RATE as i32;
        let text = match self.runner.as_ref() {
            Runner::Offline(recognizer) => {
                let stream = recognizer.create_stream();
                stream.accept_waveform(rate, audio);
                recognizer.decode(&stream);
                stream.get_result().map(|r| r.text).unwrap_or_default()
            }
            Runner::Online(recognizer) => {
                let stream = recognizer.create_stream();
                stream.accept_waveform(rate, audio);
                // Half a second of silence lets a streaming model give its last words.
                stream.accept_waveform(rate, &vec![0.0; rate as usize / 2]);
                stream.input_finished();
                while recognizer.is_ready(&stream) {
                    recognizer.decode(&stream);
                }
                recognizer.get_result(&stream).map(|r| r.text).unwrap_or_default()
            }
        };
        text.trim().to_string()
    }

    /// A recognizer for one listen, borrowing the model.
    pub fn recognizer(&self) -> Box<dyn Recognizer> {
        Box::new(Embedded(self.clone()))
    }
}

struct Embedded(Model);

impl Recognizer for Embedded {
    fn name(&self) -> String {
        format!("embedded:{}", self.0.manifest.id)
    }

    /// One reading, without a confidence. The bias isn't used: CTC models take none, and the
    /// matcher's tolerance carries the app's names.
    fn recognize(
        &mut self,
        language: Language,
        _: &[String],
        utterance: &Utterance,
    ) -> Result<Vec<Hypothesis>, String> {
        if language != self.0.manifest.language {
            return Err(format!("the {} model can't hear {}", self.0.manifest.language.code(), language.code()));
        }
        let text = self.0.transcribe(utterance.audio());
        Ok(if text.is_empty() { vec![] } else { vec![Hypothesis { text, confidence: None }] })
    }
}
