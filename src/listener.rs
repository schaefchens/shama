//! The pipeline from microphone to settled utterance: audio at any rate is resampled, cut into
//! utterances, recognized and settled against the app's vocabulary for the moment it is in. The
//! platforms drive it – a native worker thread, a web worker, a test reading a file – and pass
//! its events on. What was heard stays here, in memory, until the app's pipeline needs it.

use crate::contract::{Heard, Hypothesis, Settled, Turn};
use crate::engine::Recognizer;
use crate::listen::{Endpoint, Endpointer, Endpointing, Mode};
use crate::matcher::SettleOptions;
use crate::resample::Resampler;
use crate::vocabulary::Compiled;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct ListenerOptions {
    pub mode: Mode,
    pub endpointing: Endpointing,
    /// The microphone's sample rate.
    pub input_rate: u32,
    pub settle: SettleOptions,
    /// Hand what was heard to the app with every result – for debugging only.
    pub transcripts: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum ListenerEvent {
    Level {
        level: f32,
    },
    Speech,
    Recognizing,
    #[serde(rename_all = "camelCase")]
    Settled {
        /// Names what was heard while it is kept, for `heard`.
        id: u64,
        recognizer: String,
        speech_ms: u32,
        settled: Settled,
        #[serde(skip_serializing_if = "Option::is_none")]
        heard: Option<Vec<Hypothesis>>,
    },
    TooShort,
    NothingHeard,
    Done,
    Failed {
        message: String,
    },
}

/// How many utterances' readings are kept for the app's later stages.
const KEPT: usize = 4;

pub struct Listener {
    options: ListenerOptions,
    compiled: Arc<Compiled>,
    recognizer: Box<dyn Recognizer>,
    turn: Turn,
    bias: Vec<String>,
    resampler: Resampler,
    endpointer: Endpointer,
    next_id: u64,
    kept: VecDeque<(u64, Vec<Hypothesis>)>,
}

impl Listener {
    pub fn new(
        compiled: Arc<Compiled>,
        recognizer: Box<dyn Recognizer>,
        turn: Turn,
        options: ListenerOptions,
    ) -> Listener {
        let bias = compiled.bias(turn.language, &turn.contexts);
        Listener {
            resampler: Resampler::new(options.input_rate),
            endpointer: Endpointer::new(options.mode, options.endpointing.clone()),
            options,
            compiled,
            recognizer,
            turn,
            bias,
            next_id: 1,
            kept: VecDeque::new(),
        }
    }

    /// The moment the app is in: its language, contexts, state, what it asked, whether it speaks.
    pub fn set_turn(&mut self, turn: Turn) {
        if turn.language != self.turn.language || turn.contexts != self.turn.contexts {
            self.bias = self.compiled.bias(turn.language, &turn.contexts);
        }
        self.turn = turn;
    }

    pub fn turn(&self) -> &Turn {
        &self.turn
    }

    pub fn is_done(&self) -> bool {
        self.endpointer.is_done()
    }

    /// Takes microphone audio, one channel at the input rate.
    pub fn push(&mut self, input: &[f32]) -> Vec<ListenerEvent> {
        let audio = self.resampler.push(input);
        let endpoints = self.endpointer.push(&audio);
        self.handle(endpoints)
    }

    /// The talk button let go.
    pub fn release(&mut self) -> Vec<ListenerEvent> {
        let rest = self.resampler.finish();
        let mut endpoints = self.endpointer.push(&rest);
        endpoints.extend(self.endpointer.release());
        self.handle(endpoints)
    }

    /// The audio ended – a file read to its end.
    pub fn finish(&mut self) -> Vec<ListenerEvent> {
        let rest = self.resampler.finish();
        let mut endpoints = self.endpointer.push(&rest);
        endpoints.extend(self.endpointer.finish());
        self.handle(endpoints)
    }

    /// What was heard in an utterance, while it is kept: for a stage that needs the words.
    pub fn heard(&self, id: u64) -> Option<&[Hypothesis]> {
        self.kept.iter().find(|(kept, _)| *kept == id).map(|(_, readings)| readings.as_slice())
    }

    /// Forgets what was heard in an utterance.
    pub fn forget(&mut self, id: u64) {
        self.kept.retain(|(kept, _)| *kept != id);
    }

    /// Forgets everything heard and starts over.
    pub fn reset(&mut self) {
        self.kept.clear();
        self.resampler.reset();
        self.endpointer = Endpointer::new(self.options.mode, self.options.endpointing.clone());
    }

    fn handle(&mut self, endpoints: Vec<Endpoint>) -> Vec<ListenerEvent> {
        let mut events = Vec::new();
        for endpoint in endpoints {
            match endpoint {
                Endpoint::Level(level) => events.push(ListenerEvent::Level { level }),
                Endpoint::SpeechStarted => events.push(ListenerEvent::Speech),
                Endpoint::TooShort => events.push(ListenerEvent::TooShort),
                Endpoint::NothingHeard => events.push(ListenerEvent::NothingHeard),
                Endpoint::Done => events.push(ListenerEvent::Done),
                Endpoint::Utterance(utterance) => {
                    events.push(ListenerEvent::Recognizing);
                    match self.recognizer.recognize(self.turn.language, &self.bias, &utterance) {
                        Ok(hypotheses) => {
                            let heard = Heard {
                                recognizer: self.recognizer.name(),
                                hypotheses,
                                speech_ms: utterance.speech_ms,
                            };
                            let settled = self.compiled.settle(&self.turn, &heard, &self.options.settle);
                            let id = self.next_id;
                            self.next_id += 1;
                            if self.kept.len() == KEPT {
                                self.kept.pop_front();
                            }
                            self.kept.push_back((id, heard.hypotheses.clone()));
                            events.push(ListenerEvent::Settled {
                                id,
                                recognizer: heard.recognizer,
                                speech_ms: heard.speech_ms,
                                settled,
                                heard: self.options.transcripts.then_some(heard.hypotheses),
                            });
                        }
                        Err(message) => events.push(ListenerEvent::Failed { message }),
                    }
                }
            }
        }
        events
    }
}
