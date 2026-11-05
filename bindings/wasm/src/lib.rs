//! Shama's core for the web, through wasm-bindgen, in a worker: the vocabulary, the listener and
//! what it heard stay in the worker; JSON crosses to the page.

use serde::Deserialize;
use shama::engine::{FixtureRecognizer, Recognizer};
use shama::listen::{Endpointing, Mode, Utterance};
use shama::{
    AiReply, Call, Compiled, Hypothesis, Language, Listener, ListenerOptions, SettleOptions, Turn, Vocabulary,
};
use std::sync::Arc;
use wasm_bindgen::prelude::*;

/// The port's listen options, as far as the core takes them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListenOptions {
    mode: Mode,
    language: Language,
    #[serde(default)]
    endpointing: Endpointing,
    #[serde(default)]
    partial: bool,
    #[serde(default)]
    transcripts: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiOptions {
    brief: String,
    live: bool,
    max_calls: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckOptions {
    live: bool,
    max_calls: u32,
    reply_chars: usize,
}

/// A recognizer in the page's JavaScript – the embedded engine's WASM – called with the language,
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
pub struct Core {
    compiled: Option<Arc<Compiled>>,
    turn: Turn,
    listener: Option<Listener>,
}

impl Default for Core {
    fn default() -> Self {
        Core::new()
    }
}

#[wasm_bindgen]
impl Core {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Core {
        let turn = Turn {
            language: Language::En,
            contexts: vec![],
            state: Default::default(),
            pending: None,
            app_speaking: false,
        };
        Core { compiled: None, turn, listener: None }
    }

    /// Compiles a vocabulary: its problems as JSON, `[]` when it is good.
    #[wasm_bindgen(js_name = setVocabulary)]
    pub fn set_vocabulary(&mut self, json: &str) -> String {
        let problems = match Vocabulary::from_json(json).and_then(|vocabulary| vocabulary.compile()) {
            Ok(compiled) => {
                self.compiled = Some(Arc::new(compiled));
                Vec::new()
            }
            Err(error) => error.problems,
        };
        serde_json::to_string(&problems).unwrap_or_else(|_| "[]".into())
    }

    #[wasm_bindgen(js_name = setTurn)]
    pub fn set_turn(&mut self, json: &str) -> Result<(), JsError> {
        self.turn = serde_json::from_str(json)?;
        if let Some(listener) = &mut self.listener {
            listener.set_turn(self.turn.clone());
        }
        Ok(())
    }

    /// Starts listening to audio at `rate`, recognized by `recognize`.
    pub fn listen(&mut self, options: &str, rate: u32, name: &str, recognize: js_sys::Function) -> Result<(), JsError> {
        let recognizer = Box::new(JsRecognizer { name: name.into(), recognize });
        self.start(options, rate, recognizer)
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
        let wav = shama::wav::read(wav)?;
        let recognizer: Box<dyn Recognizer> = match (name, recognize) {
            (Some(name), Some(recognize)) => Box::new(JsRecognizer { name, recognize }),
            _ => Box::new(FixtureRecognizer::new(wav.transcripts.clone())),
        };
        self.start(options, wav.rate, recognizer)?;
        let Some(listener) = &mut self.listener else { return Ok("[]".into()) };
        let mut events = Vec::new();
        for piece in wav.samples.chunks((wav.rate as usize / 100).max(1)) {
            events.extend(listener.push(piece));
        }
        events.extend(listener.finish());
        Ok(serde_json::to_string(&events)?)
    }

    /// Takes microphone audio; what came of it as JSON.
    pub fn push(&mut self, samples: &[f32]) -> String {
        let events = self.listener.as_mut().map(|listener| listener.push(samples)).unwrap_or_default();
        serde_json::to_string(&events).unwrap_or_else(|_| "[]".into())
    }

    pub fn release(&mut self) -> String {
        let events = self.listener.as_mut().map(Listener::release).unwrap_or_default();
        serde_json::to_string(&events).unwrap_or_else(|_| "[]".into())
    }

    /// Stops listening and forgets all it heard.
    pub fn stop(&mut self) {
        if let Some(mut listener) = self.listener.take() {
            listener.reset();
        }
    }

    /// What was heard in an utterance, while it is kept: readings as JSON.
    pub fn heard(&self, id: u32) -> Option<String> {
        let readings = self.listener.as_ref()?.heard(id.into())?;
        serde_json::to_string(readings).ok()
    }

    pub fn forget(&mut self, id: u32) {
        if let Some(listener) = &mut self.listener {
            listener.forget(id.into());
        }
    }

    /// A call made complete for the moment the app is in.
    #[wasm_bindgen(js_name = finishCall)]
    pub fn finish_call(&self, call: &str) -> Result<String, JsError> {
        let call: Call = serde_json::from_str(call)?;
        let compiled = self.compiled()?;
        Ok(serde_json::to_string(&compiled.finish(&self.turn, call))?)
    }

    /// The request for an AI about an utterance, its first reading framed in it.
    #[wasm_bindgen(js_name = aiRequest)]
    pub fn ai_request(&self, id: u32, options: &str) -> Result<Option<String>, JsError> {
        let options: AiOptions = serde_json::from_str(options)?;
        let Some(heard) = self.listener.as_ref().and_then(|listener| listener.heard(id.into())).and_then(|h| h.first())
        else {
            return Ok(None);
        };
        let request =
            self.compiled()?.ai_request(&self.turn, &heard.text, &options.brief, options.live, options.max_calls);
        Ok(Some(serde_json::to_string(&request)?))
    }

    /// An AI's reply checked: what the app may act on as JSON, or `{"why": …}`.
    #[wasm_bindgen(js_name = checkReply)]
    pub fn check_reply(&self, reply: &str, options: &str) -> Result<String, JsError> {
        let reply: AiReply = serde_json::from_str(reply)?;
        let options: CheckOptions = serde_json::from_str(options)?;
        Ok(
            match self.compiled()?.check_reply(&self.turn, &reply, options.live, options.max_calls, options.reply_chars)
            {
                Ok(checked) => serde_json::to_string(&checked)?,
                Err(why) => serde_json::json!({ "why": why }).to_string(),
            },
        )
    }
}

impl Core {
    fn compiled(&self) -> Result<&Arc<Compiled>, JsError> {
        self.compiled.as_ref().ok_or_else(|| JsError::new("no vocabulary yet"))
    }

    fn start(&mut self, options: &str, rate: u32, recognizer: Box<dyn Recognizer>) -> Result<(), JsError> {
        let options: ListenOptions = serde_json::from_str(options)?;
        let compiled = self.compiled()?.clone();
        self.turn.language = options.language;
        let listener_options = ListenerOptions {
            mode: options.mode,
            endpointing: options.endpointing,
            input_rate: rate,
            settle: SettleOptions { partial: options.partial, ..SettleOptions::default() },
            transcripts: options.transcripts,
        };
        if let Some(mut old) = self.listener.take() {
            old.reset();
        }
        self.listener = Some(Listener::new(compiled, recognizer, self.turn.clone(), listener_options));
        Ok(())
    }
}
