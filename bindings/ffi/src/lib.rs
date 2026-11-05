//! Shama for Swift and Kotlin, through UniFFI: the core, the listener and what it heard stay in
//! native code; React Native's module passes JavaScript only events and results. The platform
//! brings the system's recognizer as a foreign trait, and drives the core from one serial queue.

use shama::engine::Recognizer;
use shama::host::Host;
use shama::listen::Utterance;
use shama::{Hypothesis, Language};
use std::sync::{Arc, Mutex, MutexGuard};

uniffi::setup_scaffolding!();

/// What the core couldn't do, with why. Its message becomes the Swift error's and the Kotlin
/// exception's.
#[derive(Debug, thiserror::Error, uniffi::Error)]
#[uniffi(flat_error)]
pub enum CoreError {
    #[error("{0}")]
    Invalid(String),
}

/// What a platform's recognizer couldn't hear, with why.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum RecognizerError {
    #[error("{message}")]
    Failed { message: String },
}

/// A recognizer the platform brings – the system's, held on the device. Called on the queue that
/// drives the core, it may block until it has heard.
#[uniffi::export(with_foreign)]
pub trait PlatformRecognizer: Send + Sync {
    fn name(&self) -> String;

    /// The readings of an utterance – 16 kHz mono, 16-bit little-endian PCM – as JSON:
    /// `[{ "text": …, "confidence": … }]`, the likeliest first; `bias` lists phrases to favor.
    fn recognize(&self, language: String, bias: Vec<String>, audio: Vec<u8>) -> Result<String, RecognizerError>;
}

struct Platform(Arc<dyn PlatformRecognizer>);

impl Recognizer for Platform {
    fn name(&self) -> String {
        self.0.name()
    }

    fn recognize(
        &mut self,
        language: Language,
        bias: &[String],
        utterance: &Utterance,
    ) -> Result<Vec<Hypothesis>, String> {
        let json = self
            .0
            .recognize(language.code().into(), bias.to_vec(), pcm16(utterance.audio()))
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&json).map_err(|e| e.to_string())
    }
}

/// Audio as 16-bit little-endian PCM.
fn pcm16(samples: &[f32]) -> Vec<u8> {
    samples.iter().flat_map(|sample| ((sample.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()).collect()
}

#[derive(uniffi::Object, Default)]
pub struct ShamaCore(Mutex<Host>);

impl ShamaCore {
    fn host(&self) -> MutexGuard<'_, Host> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[uniffi::export]
impl ShamaCore {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(ShamaCore::default())
    }

    /// Compiles a vocabulary: its problems as JSON, `[]` when it is good.
    pub fn set_vocabulary(&self, json: String) -> String {
        self.host().set_vocabulary(&json)
    }

    pub fn set_turn(&self, json: String) -> Result<(), CoreError> {
        self.host().set_turn(&json).map_err(CoreError::Invalid)
    }

    /// Starts listening to audio at `rate`, heard by the platform's recognizer.
    pub fn listen(&self, options: String, rate: u32, recognizer: Arc<dyn PlatformRecognizer>) -> Result<(), CoreError> {
        self.host().listen(&options, rate, Box::new(Platform(recognizer))).map_err(CoreError::Invalid)
    }

    /// Listens to a WAV file to its end – the test path – and returns all that came of it as JSON.
    /// Without a recognizer, the file's own transcripts are what is heard.
    pub fn listen_file(
        &self,
        options: String,
        path: String,
        recognizer: Option<Arc<dyn PlatformRecognizer>>,
    ) -> Result<String, CoreError> {
        let wav = std::fs::read(&path).map_err(|e| CoreError::Invalid(format!("{path}: {e}")))?;
        let recognizer = recognizer.map(|recognizer| Box::new(Platform(recognizer)) as Box<dyn Recognizer>);
        self.host().listen_wav(&options, &wav, recognizer).map_err(CoreError::Invalid)
    }

    /// Takes microphone audio, one channel at the listening rate; what came of it as JSON.
    pub fn push(&self, samples: Vec<f32>) -> String {
        self.host().push(&samples)
    }

    /// Takes microphone audio as 16-bit little-endian PCM – what Android's recorder gives.
    pub fn push_pcm16(&self, pcm: Vec<u8>) -> String {
        let samples: Vec<f32> =
            pcm.chunks_exact(2).map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32768.0).collect();
        self.host().push(&samples)
    }

    /// The talk button let go: what came of it as JSON.
    pub fn release(&self) -> String {
        self.host().release()
    }

    /// Stops listening and forgets all it heard.
    pub fn stop(&self) {
        self.host().stop();
    }

    /// What was heard in an utterance, while it is kept: readings as JSON.
    pub fn heard(&self, id: u32) -> Option<String> {
        self.host().heard(id.into())
    }

    pub fn forget(&self, id: u32) {
        self.host().forget(id.into());
    }

    /// A call made complete for the moment the app is in: an outcome as JSON.
    pub fn finish_call(&self, call: String) -> Result<String, CoreError> {
        self.host().finish_call(&call).map_err(CoreError::Invalid)
    }

    /// The request for an AI about an utterance, its first reading framed in it.
    pub fn ai_request(&self, id: u32, options: String) -> Result<Option<String>, CoreError> {
        self.host().ai_request(id.into(), &options).map_err(CoreError::Invalid)
    }

    /// An AI's reply checked: what the app may act on as JSON, or `{"why": …}`.
    pub fn check_reply(&self, reply: String, options: String) -> Result<String, CoreError> {
        self.host().check_reply(&reply, &options).map_err(CoreError::Invalid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Hears(&'static str);

    impl PlatformRecognizer for Hears {
        fn name(&self) -> String {
            "test".into()
        }

        fn recognize(&self, _: String, bias: Vec<String>, audio: Vec<u8>) -> Result<String, RecognizerError> {
            assert!(!bias.is_empty() && audio.len().is_multiple_of(2) && audio.iter().any(|b| *b != 0));
            Ok(format!(r#"[{{"text":"{}"}}]"#, self.0))
        }
    }

    #[test]
    fn audio_in_events_out() {
        let core = ShamaCore::new();
        let vocabulary =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/vocabulary.json"))
                .unwrap();
        assert_eq!(core.set_vocabulary(vocabulary), "[]");
        core.listen(r#"{"mode":"hold","language":"en"}"#.into(), 16_000, Arc::new(Hears("read Faust"))).unwrap();
        let voice: Vec<f32> = (0..16_000).map(|i| 0.1 * (i as f32 * 0.06).sin()).collect();
        let mut events = core.push(vec![0.0; 8000]);
        events.push_str(&core.push_pcm16(pcm16(&voice)));
        let released: serde_json::Value = serde_json::from_str(&core.release()).unwrap();
        let settled = released.as_array().unwrap().iter().find(|e| e["event"] == "settled").expect("settled");
        assert_eq!(settled["settled"]["outcome"]["calls"][0]["args"]["book"], "faust");
        assert_eq!(core.heard(settled["id"].as_u64().unwrap() as u32).unwrap(), r#"[{"text":"read Faust"}]"#);
        assert!(events.contains("speech"));
    }
}
