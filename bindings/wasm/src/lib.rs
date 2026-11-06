//! Shama's core for the web, through wasm-bindgen, in a worker: the vocabulary, the listener and
//! what it heard stay in the worker; JSON crosses to the page.

use shama::engine::Recognizer;
use shama::host::Host;
use shama::listen::Utterance;
use shama::{Hypothesis, Language};
use wasm_bindgen::prelude::*;

/// A recognizer in the worker's JavaScript – the embedded engine's WASM – called with the language,
/// the bias as JSON and the utterance's 16 kHz audio, answering readings as JSON.
struct JsRecognizer {
    name: String,
    recognize: js_sys::Function,
}

impl Recognizer for JsRecognizer {
    fn name(&self) -> String {
        self.name.clone()
    }

    fn recognize(
        &mut self,
        language: Language,
        bias: &[String],
        utterance: &Utterance,
    ) -> Result<Vec<Hypothesis>, String> {
        let audio = js_sys::Float32Array::from(utterance.audio());
        let bias = serde_json::to_string(bias).map_err(|e| e.to_string())?;
        let answer = self
            .recognize
            .call3(&JsValue::NULL, &JsValue::from_str(language.code()), &JsValue::from_str(&bias), &audio)
            .map_err(|error| format!("{error:?}"))?;
        audio.fill(0.0, 0, audio.length());
        let json = answer.as_string().ok_or("the recognizer answered no JSON")?;
        serde_json::from_str(&json).map_err(|e| e.to_string())
    }
}

#[wasm_bindgen]
pub struct Core(Host);

impl Default for Core {
    fn default() -> Self {
        Core::new()
    }
}

fn error(message: String) -> JsError {
    JsError::new(&message)
}

#[wasm_bindgen]
impl Core {
    /// Recognizers timed by the worker's clock: WASM has none of its own.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Core {
        Core(Host::with_clock(js_sys::Date::now))
    }

    /// Compiles a vocabulary: its problems as JSON, `[]` when it is good.
    #[wasm_bindgen(js_name = setVocabulary)]
    pub fn set_vocabulary(&mut self, json: &str) -> String {
        self.0.set_vocabulary(json)
    }

    #[wasm_bindgen(js_name = setTurn)]
    pub fn set_turn(&mut self, json: &str) -> Result<(), JsError> {
        self.0.set_turn(json).map_err(error)
    }

    /// Starts listening to audio at `rate`, recognized by `recognize`.
    pub fn listen(&mut self, options: &str, rate: u32, name: &str, recognize: js_sys::Function) -> Result<(), JsError> {
        self.0.listen(options, rate, Box::new(JsRecognizer { name: name.into(), recognize })).map_err(error)
    }

    /// Listens to a WAV file to its end – Shama's test path – and returns all that came of it as
    /// JSON. Without a recognizer, the file's own transcripts are what is heard.
    #[wasm_bindgen(js_name = listenFile)]
    pub fn listen_file(
        &mut self,
        options: &str,
        wav: &[u8],
        name: Option<String>,
        recognize: Option<js_sys::Function>,
    ) -> Result<String, JsError> {
        let recognizer: Option<Box<dyn Recognizer>> = match (name, recognize) {
            (Some(name), Some(recognize)) => Some(Box::new(JsRecognizer { name, recognize })),
            _ => None,
        };
        self.0.listen_wav(options, wav, recognizer).map_err(error)
    }

    /// Settles a text as if it had been heard – the test path; what came of it as JSON.
    #[wasm_bindgen(js_name = listenText)]
    pub fn listen_text(&mut self, options: &str, text: &str) -> Result<String, JsError> {
        self.0.listen_text(options, text).map_err(error)
    }

    /// Takes microphone audio; what came of it as JSON.
    pub fn push(&mut self, samples: &[f32]) -> String {
        self.0.push(samples)
    }

    pub fn release(&mut self) -> String {
        self.0.release()
    }

    /// Stops listening and forgets all it heard.
    pub fn stop(&mut self) {
        self.0.stop();
    }

    /// What was heard in an utterance, while it is kept: readings as JSON.
    pub fn heard(&self, id: u32) -> Option<String> {
        self.0.heard(id.into())
    }

    pub fn forget(&mut self, id: u32) {
        self.0.forget(id.into());
    }

    /// An utterance's audio kept for debugging, as a WAV file – 16 kHz, 16-bit.
    #[wasm_bindgen(js_name = recordingWav)]
    pub fn recording_wav(&self, id: u32) -> Option<Vec<u8>> {
        self.0.recording_wav(id.into())
    }

    /// An utterance's audio kept for debugging: 16 kHz samples.
    #[wasm_bindgen(js_name = recordingAudio)]
    pub fn recording_audio(&self, id: u32) -> Option<Vec<f32>> {
        self.0.recording(id.into()).map(|recording| recording.audio().to_vec())
    }

    /// Wipes the audio kept for debugging.
    #[wasm_bindgen(js_name = forgetRecordings)]
    pub fn forget_recordings(&mut self) {
        self.0.forget_recordings();
    }

    /// A call made complete for the moment the app is in.
    #[wasm_bindgen(js_name = finishCall)]
    pub fn finish_call(&self, call: &str) -> Result<String, JsError> {
        self.0.finish_call(call).map_err(error)
    }

    /// The request for an AI about an utterance, its first reading framed in it.
    #[wasm_bindgen(js_name = aiRequest)]
    pub fn ai_request(&self, id: u32, options: &str) -> Result<Option<String>, JsError> {
        self.0.ai_request(id.into(), options).map_err(error)
    }

    /// An AI's reply checked: what the app may act on as JSON, or `{"why": …}`.
    #[wasm_bindgen(js_name = checkReply)]
    pub fn check_reply(&self, reply: &str, options: &str) -> Result<String, JsError> {
        self.0.check_reply(reply, options).map_err(error)
    }
}
