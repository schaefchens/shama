//! What a platform's binding holds – the compiled vocabulary, the moment the app is in, the
//! listener and what it heard – with JSON in and out, as bindings pass it. The web's worker and
//! the native module each wrap one.

use crate::contract::{Call, Turn};
use crate::engine::{FixtureRecognizer, Recognizer};
use crate::listen::{Endpointing, Mode};
use crate::listener::{Listener, ListenerOptions};
use crate::matcher::SettleOptions;
use crate::vocabulary::{Compiled, Vocabulary};
use crate::{AiReply, Language};
use serde::Deserialize;
use std::sync::Arc;

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

pub struct Host {
    compiled: Option<Arc<Compiled>>,
    turn: Turn,
    listener: Option<Listener>,
}

impl Default for Host {
    fn default() -> Self {
        Host::new()
    }
}

impl Host {
    pub fn new() -> Host {
        let turn = Turn {
            language: Language::En,
            contexts: vec![],
            state: Default::default(),
            pending: None,
            app_speaking: false,
        };
        Host { compiled: None, turn, listener: None }
    }

    /// Compiles a vocabulary: its problems as JSON, `[]` when it is good.
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

    pub fn set_turn(&mut self, json: &str) -> Result<(), String> {
        self.turn = serde_json::from_str(json).map_err(|e| e.to_string())?;
        if let Some(listener) = &mut self.listener {
            listener.set_turn(self.turn.clone());
        }
        Ok(())
    }

    /// Starts listening to audio at `rate`, heard by `recognizer`.
    pub fn listen(&mut self, options: &str, rate: u32, recognizer: Box<dyn Recognizer>) -> Result<(), String> {
        let options: ListenOptions = serde_json::from_str(options).map_err(|e| e.to_string())?;
        let compiled = self.compiled.clone().ok_or("no vocabulary yet")?;
        self.turn.language = options.language;
        let listener_options = ListenerOptions {
            mode: options.mode,
            endpointing: options.endpointing,
            input_rate: rate,
            settle: SettleOptions { partial: options.partial, ..SettleOptions::default() },
            transcripts: options.transcripts,
        };
        self.stop();
        self.listener = Some(Listener::new(compiled, recognizer, self.turn.clone(), listener_options));
        Ok(())
    }

    /// Listens to a WAV file to its end – the test path – and returns all that came of it as JSON.
    /// Without a recognizer, the file's own transcripts are what is heard.
    pub fn listen_wav(
        &mut self,
        options: &str,
        wav: &[u8],
        recognizer: Option<Box<dyn Recognizer>>,
    ) -> Result<String, String> {
        let wav = crate::wav::read(wav).map_err(|e| e.to_string())?;
        let recognizer = recognizer.unwrap_or_else(|| Box::new(FixtureRecognizer::new(wav.transcripts.clone())));
        self.listen(options, wav.rate, recognizer)?;
        let Some(listener) = &mut self.listener else { return Ok("[]".into()) };
        let mut events = Vec::new();
        for piece in wav.samples.chunks((wav.rate as usize / 100).max(1)) {
            events.extend(listener.push(piece));
        }
        events.extend(listener.finish());
        serde_json::to_string(&events).map_err(|e| e.to_string())
    }

    /// Takes microphone audio; what came of it as JSON.
    pub fn push(&mut self, samples: &[f32]) -> String {
        let events = self.listener.as_mut().map(|listener| listener.push(samples)).unwrap_or_default();
        serde_json::to_string(&events).unwrap_or_else(|_| "[]".into())
    }

    /// The talk button let go: what came of it as JSON.
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
    pub fn heard(&self, id: u64) -> Option<String> {
        let readings = self.listener.as_ref()?.heard(id)?;
        serde_json::to_string(readings).ok()
    }

    pub fn forget(&mut self, id: u64) {
        if let Some(listener) = &mut self.listener {
            listener.forget(id);
        }
    }

    /// A call made complete for the moment the app is in: an outcome as JSON.
    pub fn finish_call(&self, call: &str) -> Result<String, String> {
        let call: Call = serde_json::from_str(call).map_err(|e| e.to_string())?;
        let compiled = self.compiled.as_ref().ok_or("no vocabulary yet")?;
        serde_json::to_string(&compiled.finish(&self.turn, call)).map_err(|e| e.to_string())
    }

    /// The request for an AI about an utterance, its first reading framed in it – none when it
    /// is no longer kept.
    pub fn ai_request(&self, id: u64, options: &str) -> Result<Option<String>, String> {
        let options: AiOptions = serde_json::from_str(options).map_err(|e| e.to_string())?;
        let Some(heard) = self.listener.as_ref().and_then(|listener| listener.heard(id)).and_then(|h| h.first()) else {
            return Ok(None);
        };
        let compiled = self.compiled.as_ref().ok_or("no vocabulary yet")?;
        let request = compiled.ai_request(&self.turn, &heard.text, &options.brief, options.live, options.max_calls);
        serde_json::to_string(&request).map(Some).map_err(|e| e.to_string())
    }

    /// An AI's reply checked: what the app may act on as JSON, or `{"why": …}`.
    pub fn check_reply(&self, reply: &str, options: &str) -> Result<String, String> {
        let reply: AiReply = serde_json::from_str(reply).map_err(|e| e.to_string())?;
        let options: CheckOptions = serde_json::from_str(options).map_err(|e| e.to_string())?;
        let compiled = self.compiled.as_ref().ok_or("no vocabulary yet")?;
        let checked =
            match compiled.check_reply(&self.turn, &reply, options.live, options.max_calls, options.reply_chars) {
                Ok(checked) => serde_json::to_value(&checked),
                Err(why) => Ok(serde_json::json!({ "why": why })),
            };
        checked.map(|value| value.to_string()).map_err(|e| e.to_string())
    }
}
