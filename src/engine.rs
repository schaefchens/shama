//! Recognizers: what turns an utterance into readings. The platforms bring theirs – the system's
//! on the device, an embedded model; the core has two for tests: one that reads a fixture WAV's
//! transcripts, and one that says what it is told.

use crate::Language;
use crate::contract::Hypothesis;
use crate::listen::Utterance;
use crate::wav::Transcript;
use std::collections::VecDeque;

pub trait Recognizer: Send {
    /// Named in results' trails: "os", "embedded:…", "fixture".
    fn name(&self) -> String;

    /// The readings of an utterance, the likeliest first; `bias` lists phrases to favor.
    fn recognize(
        &mut self,
        language: Language,
        bias: &[String],
        utterance: &Utterance,
    ) -> Result<Vec<Hypothesis>, String>;
}

/// Hears what a fixture WAV's transcripts say was said where the utterance is.
pub struct FixtureRecognizer {
    transcripts: Vec<Transcript>,
}

impl FixtureRecognizer {
    pub fn new(transcripts: Vec<Transcript>) -> FixtureRecognizer {
        FixtureRecognizer { transcripts }
    }
}

impl Recognizer for FixtureRecognizer {
    fn name(&self) -> String {
        "fixture".into()
    }

    fn recognize(&mut self, _: Language, _: &[String], utterance: &Utterance) -> Result<Vec<Hypothesis>, String> {
        let overlap =
            |t: &Transcript| t.end_ms.min(utterance.end_ms).saturating_sub(t.start_ms.max(utterance.start_ms));
        Ok(self
            .transcripts
            .iter()
            .filter(|t| overlap(t) > 0)
            .max_by_key(|t| overlap(t))
            .map(|t| vec![Hypothesis { text: t.text.clone(), confidence: t.confidence }])
            .unwrap_or_default())
    }
}

/// Hears, utterance after utterance, the readings it was given.
pub struct ScriptedRecognizer {
    readings: VecDeque<Vec<Hypothesis>>,
}

impl ScriptedRecognizer {
    pub fn new(readings: impl IntoIterator<Item = Vec<Hypothesis>>) -> ScriptedRecognizer {
        ScriptedRecognizer { readings: readings.into_iter().collect() }
    }
}

impl Recognizer for ScriptedRecognizer {
    fn name(&self) -> String {
        "scripted".into()
    }

    fn recognize(&mut self, _: Language, _: &[String], _: &Utterance) -> Result<Vec<Hypothesis>, String> {
        Ok(self.readings.pop_front().unwrap_or_default())
    }
}
