//! The pipeline from microphone to settled utterance: audio at any rate is resampled, cut into
//! utterances, recognized and settled against the app's vocabulary for the moment it is in. The
//! platforms drive it – a native worker thread, a web worker, a test reading a file – and pass
//! its events on. What was heard stays here, in memory, until the app's pipeline needs it.
//!
//! For debugging, it tells more: the meter in full, each utterance as it is cut, how long
//! recognizing took – and keeps utterances' audio when asked to, for the app to play or save.

use crate::Language;
use crate::contract::{Heard, Hypothesis, Settled, Turn};
use crate::engine::Recognizer;
use crate::listen::{Cut, Endpoint, Endpointer, Endpointing, Meter, Mode, Phase};
use crate::matcher::SettleOptions;
use crate::resample::{RATE, Resampler};
use crate::vocabulary::Compiled;
use crate::wav::{self, Transcript};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

/// Milliseconds since some fixed moment: how long recognizing takes is told by it.
pub type Clock = fn() -> f64;

/// The platform's clock – none in a browser's WASM, whose worker brings its own.
pub fn system_clock() -> f64 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        START.get_or_init(std::time::Instant::now).elapsed().as_secs_f64() * 1000.0
    }
    #[cfg(target_arch = "wasm32")]
    {
        0.0
    }
}

#[derive(Clone, Debug)]
pub struct ListenerOptions {
    pub mode: Mode,
    pub endpointing: Endpointing,
    /// The microphone's sample rate.
    pub input_rate: u32,
    pub settle: SettleOptions,
    /// Hand what was heard to the app with every result – for debugging only.
    pub transcripts: bool,
    /// Tell the meter in full and each utterance as it is cut – for debugging.
    pub diagnostics: bool,
    /// Keep each utterance's audio for the app to play back or save – for debugging only.
    pub keep_audio: bool,
    /// The first utterance's id: ids go on from one listening to the next.
    pub first_id: u64,
    pub clock: Clock,
}

impl Default for ListenerOptions {
    fn default() -> Self {
        ListenerOptions {
            mode: Mode::Tap,
            endpointing: Endpointing::default(),
            input_rate: RATE,
            settle: SettleOptions::default(),
            transcripts: false,
            diagnostics: false,
            keep_audio: false,
            first_id: 1,
            clock: system_clock,
        }
    }
}

/// Where audio comes from, as the platform tells it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    /// The microphone as the system names it – or "file".
    pub device: String,
    /// `builtIn`, `wired`, `bluetooth`, `usb`, `file`, `other`.
    pub kind: String,
    /// The rate audio comes at, before it is resampled to 16 kHz.
    pub rate: u32,
    pub channels: u32,
    /// How the system was asked to treat it: a session's mode, a recording source, constraints.
    pub processing: String,
    pub echo_cancellation: bool,
    /// Anything more the platform tells.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub details: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum ListenerEvent {
    Level {
        level: f32,
    },
    /// With diagnostics: the meter in full, in place of the level.
    #[serde(rename_all = "camelCase")]
    Meter {
        level: f32,
        rms_db: f32,
        peak_db: f32,
        clipped: bool,
        floor_db: f32,
        threshold_db: f32,
        phase: Phase,
    },
    /// With diagnostics: where audio comes from – the core tells it for files.
    Input {
        input: Input,
    },
    Speech,
    /// With diagnostics: an utterance cut from the audio, before it is recognized. `kept`: its
    /// audio is kept for the app.
    #[serde(rename_all = "camelCase")]
    Utterance {
        id: u64,
        start_ms: u64,
        end_ms: u64,
        speech_ms: u32,
        cut: Cut,
        kept: bool,
    },
    Recognizing,
    #[serde(rename_all = "camelCase")]
    Settled {
        /// Names what was heard while it is kept, for `heard`.
        id: u64,
        recognizer: String,
        speech_ms: u32,
        /// How long the recognizer took.
        recognize_ms: u32,
        settled: Settled,
        #[serde(skip_serializing_if = "Option::is_none")]
        heard: Option<Vec<Hypothesis>>,
    },
    /// Sound too short to be speech, dropped: how long it was loud.
    #[serde(rename_all = "camelCase")]
    TooShort {
        speech_ms: u32,
    },
    NothingHeard,
    Done,
    Failed {
        message: String,
    },
}

/// An utterance's audio kept for debugging: 16 kHz, in memory only, wiped when dropped.
pub struct Recording {
    pub id: u64,
    pub language: Language,
    audio: Vec<f32>,
    /// What was heard in it, when the app asked for transcripts.
    pub heard: Option<String>,
}

impl Recording {
    pub fn audio(&self) -> &[f32] {
        &self.audio
    }

    pub fn duration_ms(&self) -> u64 {
        self.audio.len() as u64 * 1000 / RATE as u64
    }

    /// As a WAV file, what was heard in Shama's chunk – so that it can be heard again as a fixture.
    pub fn wav(&self) -> Vec<u8> {
        let transcripts: Vec<Transcript> = self
            .heard
            .iter()
            .map(|text| Transcript { start_ms: 0, end_ms: self.duration_ms(), text: text.clone(), confidence: None })
            .collect();
        wav::write_samples(RATE, &self.audio, &transcripts)
    }
}

impl Drop for Recording {
    fn drop(&mut self) {
        self.audio.fill(0.0);
    }
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
    /// Audio kept since the host last took it.
    recordings: Vec<Recording>,
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
            compiled,
            recognizer,
            turn,
            bias,
            next_id: options.first_id,
            kept: VecDeque::new(),
            recordings: Vec::new(),
            options,
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

    /// The id the next utterance gets.
    pub fn next_id(&self) -> u64 {
        self.next_id
    }

    /// The audio kept since this was last asked.
    pub fn take_recordings(&mut self) -> Vec<Recording> {
        std::mem::take(&mut self.recordings)
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

    /// A text, settled as if it had been heard – the test path: no audio, the same stages after.
    pub fn hear_text(&mut self, text: &str) -> Vec<ListenerEvent> {
        let heard = Heard {
            recognizer: "text".into(),
            hypotheses: vec![Hypothesis { text: text.into(), confidence: None }],
            speech_ms: 0,
        };
        let id = self.take_id();
        let mut events = vec![ListenerEvent::Speech, ListenerEvent::Recognizing, self.settle(id, heard, 0)];
        if self.options.mode != Mode::Continuous {
            events.push(ListenerEvent::Done);
        }
        events
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

    fn take_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// The level – or with diagnostics, the meter in full.
    fn level(&self, meter: Meter) -> ListenerEvent {
        if !self.options.diagnostics {
            return ListenerEvent::Level { level: meter.level };
        }
        let Meter { level, rms_db, peak_db, clipped, floor_db, threshold_db, phase } = meter;
        ListenerEvent::Meter { level, rms_db, peak_db, clipped, floor_db, threshold_db, phase }
    }

    /// Readings settled for the moment the app is in, and kept for a later stage.
    fn settle(&mut self, id: u64, heard: Heard, recognize_ms: u32) -> ListenerEvent {
        let settled = self.compiled.settle(&self.turn, &heard, &self.options.settle);
        if self.kept.len() == KEPT {
            self.kept.pop_front();
        }
        self.kept.push_back((id, heard.hypotheses.clone()));
        ListenerEvent::Settled {
            id,
            recognizer: heard.recognizer,
            speech_ms: heard.speech_ms,
            recognize_ms,
            settled,
            heard: self.options.transcripts.then_some(heard.hypotheses),
        }
    }

    fn handle(&mut self, endpoints: Vec<Endpoint>) -> Vec<ListenerEvent> {
        let mut events = Vec::new();
        for endpoint in endpoints {
            match endpoint {
                Endpoint::Level(meter) => events.push(self.level(meter)),
                Endpoint::SpeechStarted => events.push(ListenerEvent::Speech),
                Endpoint::TooShort(speech_ms) => events.push(ListenerEvent::TooShort { speech_ms }),
                Endpoint::NothingHeard => events.push(ListenerEvent::NothingHeard),
                Endpoint::Done => events.push(ListenerEvent::Done),
                Endpoint::Utterance(utterance) => {
                    let id = self.take_id();
                    let keep = self.options.keep_audio;
                    if keep {
                        self.recordings.push(Recording {
                            id,
                            language: self.turn.language,
                            audio: utterance.audio().to_vec(),
                            heard: None,
                        });
                    }
                    if self.options.diagnostics {
                        events.push(ListenerEvent::Utterance {
                            id,
                            start_ms: utterance.start_ms,
                            end_ms: utterance.end_ms,
                            speech_ms: utterance.speech_ms,
                            cut: utterance.cut,
                            kept: keep,
                        });
                    }
                    events.push(ListenerEvent::Recognizing);
                    let started = (self.options.clock)();
                    match self.recognizer.recognize(self.turn.language, &self.bias, &utterance) {
                        Ok(hypotheses) => {
                            let recognize_ms = ((self.options.clock)() - started).max(0.0).round() as u32;
                            if keep
                                && self.options.transcripts
                                && let Some(recording) = self.recordings.iter_mut().find(|r| r.id == id)
                            {
                                recording.heard = hypotheses.first().map(|h| h.text.clone());
                            }
                            let heard = Heard {
                                recognizer: self.recognizer.name(),
                                hypotheses,
                                speech_ms: utterance.speech_ms,
                            };
                            events.push(self.settle(id, heard, recognize_ms));
                        }
                        Err(message) => events.push(ListenerEvent::Failed { message }),
                    }
                }
            }
        }
        events
    }
}
