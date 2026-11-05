//! Where speech begins and ends: an energy rule on 20 ms frames, its noise floor following the
//! room. It cuts one utterance for push-to-talk, or a stream into utterances for LIVE.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

/// 20 ms at 16 kHz.
pub const FRAME: usize = 320;
const FRAME_MS: u32 = 20;
/// Recent quiet frames the noise floor is taken from: 1.5 s.
const FLOOR_FRAMES: usize = 75;
/// Loud frames in a row that begin speech.
const START_FRAMES: u32 = 3;
/// A level event every this many frames: about 17 a second.
const LEVEL_EVERY: u64 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// One utterance, ended by a pause.
    Tap,
    /// One utterance, ended when the button is let go.
    Hold,
    /// Utterance after utterance (LIVE).
    Continuous,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Endpointing {
    pub end_pause_ms: u32,
    pub max_utterance_ms: u32,
    /// Without speech this long, a turn ends; 0 never ends it.
    pub nothing_heard_ms: u32,
    /// The first moments only learn the room: the microphone settling, the app's voice fading.
    pub settle_ms: u32,
    pub min_speech_ms: u32,
    pub pre_roll_ms: u32,
    pub post_roll_ms: u32,
}

impl Default for Endpointing {
    fn default() -> Self {
        Endpointing {
            end_pause_ms: 900,
            max_utterance_ms: 15_000,
            nothing_heard_ms: 6_000,
            settle_ms: 200,
            min_speech_ms: 120,
            pre_roll_ms: 300,
            post_roll_ms: 400,
        }
    }
}

impl Endpointing {
    /// LIVE's: a shorter end pause, and no end for silence.
    pub fn live() -> Endpointing {
        Endpointing { end_pause_ms: 700, nothing_heard_ms: 0, ..Endpointing::default() }
    }
}

/// An utterance's audio, at 16 kHz, kept in memory only and wiped when dropped.
#[derive(Debug, PartialEq)]
pub struct Utterance {
    audio: Vec<f32>,
    pub start_ms: u64,
    pub end_ms: u64,
    pub speech_ms: u32,
}

impl Utterance {
    pub fn new(audio: Vec<f32>, start_ms: u64, speech_ms: u32) -> Utterance {
        let end_ms = start_ms + audio.len() as u64 * 1000 / crate::resample::RATE as u64;
        Utterance { audio, start_ms, end_ms, speech_ms }
    }

    pub fn audio(&self) -> &[f32] {
        &self.audio
    }
}

impl Drop for Utterance {
    fn drop(&mut self) {
        self.audio.fill(0.0);
    }
}

#[derive(Debug, PartialEq)]
pub enum Endpoint {
    /// The microphone's level, 0 to 1, for the app to show.
    Level(f32),
    SpeechStarted,
    Utterance(Utterance),
    /// Sound too short to be speech – a click, a knock – dropped.
    TooShort,
    NothingHeard,
    /// The turn is over: push-to-talk takes no more audio.
    Done,
}

pub struct Endpointer {
    mode: Mode,
    settings: Endpointing,
    frame: Vec<f32>,
    frames: u64,
    quiet: VecDeque<f32>,
    /// The last moments before speech, to keep its beginning.
    recent: VecDeque<f32>,
    state: State,
    /// When the turn began or the last utterance ended, for "nothing heard".
    since: u64,
    heard_any: bool,
}

enum State {
    Waiting { loud_run: u32 },
    Speaking { audio: Vec<f32>, start_ms: u64, loud_frames: u32, quiet_run: u32, last_loud_end: usize },
    Done,
}

impl Endpointer {
    pub fn new(mode: Mode, settings: Endpointing) -> Endpointer {
        Endpointer {
            mode,
            settings,
            frame: Vec::with_capacity(FRAME),
            frames: 0,
            quiet: VecDeque::with_capacity(FLOOR_FRAMES),
            recent: VecDeque::new(),
            state: State::Waiting { loud_run: 0 },
            since: 0,
            heard_any: false,
        }
    }

    pub fn is_done(&self) -> bool {
        matches!(self.state, State::Done)
    }

    /// Takes 16 kHz audio and returns what it brought about.
    pub fn push(&mut self, samples: &[f32]) -> Vec<Endpoint> {
        let mut events = Vec::new();
        for &sample in samples {
            if self.is_done() {
                break;
            }
            self.frame.push(sample);
            if self.frame.len() == FRAME {
                let frame = std::mem::replace(&mut self.frame, Vec::with_capacity(FRAME));
                self.process(&frame, &mut events);
            }
        }
        events
    }

    /// The button let go: what was said so far is the utterance.
    pub fn release(&mut self) -> Vec<Endpoint> {
        let mut events = Vec::new();
        match self.state {
            State::Speaking { .. } => self.end(&mut events),
            State::Waiting { .. } => {
                if !self.heard_any {
                    events.push(Endpoint::NothingHeard);
                }
            }
            State::Done => return events,
        }
        self.done(&mut events);
        events
    }

    /// The stream ended – a file read to its end.
    pub fn finish(&mut self) -> Vec<Endpoint> {
        let mut events = Vec::new();
        if let State::Speaking { .. } = self.state {
            self.end(&mut events);
        }
        if !self.is_done() {
            self.done(&mut events);
        }
        events
    }

    fn done(&mut self, events: &mut Vec<Endpoint>) {
        self.state = State::Done;
        self.recent.iter_mut().for_each(|sample| *sample = 0.0);
        self.recent.clear();
        self.frame.fill(0.0);
        events.push(Endpoint::Done);
    }

    fn floor(&self) -> f32 {
        if self.quiet.is_empty() {
            return 0.002;
        }
        let mut levels: Vec<f32> = self.quiet.iter().copied().collect();
        levels.sort_by(f32::total_cmp);
        levels[levels.len() / 5].max(0.0005)
    }

    fn process(&mut self, frame: &[f32], events: &mut Vec<Endpoint>) {
        let rms = (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt();
        self.frames += 1;
        let now_ms = self.frames * FRAME_MS as u64;
        if self.frames.is_multiple_of(LEVEL_EVERY) {
            let decibels = 20.0 * rms.max(1e-6).log10();
            events.push(Endpoint::Level(((decibels + 60.0) / 60.0).clamp(0.0, 1.0)));
        }
        let pre_roll = (self.settings.pre_roll_ms / FRAME_MS) as usize * FRAME + START_FRAMES as usize * FRAME;
        self.recent.extend(frame.iter().copied());
        while self.recent.len() > pre_roll {
            self.recent.pop_front();
        }
        if self.frames * (FRAME_MS as u64) <= self.settings.settle_ms as u64 {
            self.learn(rms);
            return;
        }
        let floor = self.floor();
        let loud = rms > (3.0 * floor).max(0.012);
        match &mut self.state {
            State::Waiting { loud_run } => {
                if loud {
                    *loud_run += 1;
                    if *loud_run >= START_FRAMES {
                        let audio: Vec<f32> = self.recent.iter().copied().collect();
                        let start_ms = now_ms.saturating_sub(audio.len() as u64 * 1000 / crate::resample::RATE as u64);
                        let last_loud_end = audio.len();
                        self.state =
                            State::Speaking { audio, start_ms, loud_frames: START_FRAMES, quiet_run: 0, last_loud_end };
                        self.heard_any = true;
                        events.push(Endpoint::SpeechStarted);
                    }
                } else {
                    *loud_run = 0;
                    self.learn(rms);
                    let waited = (now_ms - self.since) as u32;
                    if self.mode != Mode::Continuous
                        && self.settings.nothing_heard_ms > 0
                        && waited >= self.settings.nothing_heard_ms
                    {
                        events.push(Endpoint::NothingHeard);
                        self.done(events);
                    }
                }
            }
            State::Speaking { audio, loud_frames, quiet_run, last_loud_end, .. } => {
                audio.extend_from_slice(frame);
                if loud {
                    *loud_frames += 1;
                    *quiet_run = 0;
                    *last_loud_end = audio.len();
                } else {
                    *quiet_run += 1;
                }
                let long =
                    (audio.len() as u64 * 1000 / crate::resample::RATE as u64) >= self.settings.max_utterance_ms as u64;
                let paused = self.mode != Mode::Hold && *quiet_run * FRAME_MS >= self.settings.end_pause_ms;
                if long || paused {
                    self.end(events);
                    if self.mode == Mode::Tap && matches!(events.last(), Some(Endpoint::Utterance(_))) {
                        self.done(events);
                    }
                }
            }
            State::Done => {}
        }
    }

    /// The noise floor follows the room, from frames without speech.
    fn learn(&mut self, rms: f32) {
        if self.quiet.len() == FLOOR_FRAMES {
            self.quiet.pop_front();
        }
        self.quiet.push_back(rms);
    }

    /// Ends the utterance being spoken: kept if it was speech long enough, else dropped.
    fn end(&mut self, events: &mut Vec<Endpoint>) {
        let state = std::mem::replace(&mut self.state, State::Waiting { loud_run: 0 });
        let State::Speaking { mut audio, start_ms, loud_frames, last_loud_end, .. } = state else {
            self.state = state;
            return;
        };
        self.since = self.frames * FRAME_MS as u64;
        let speech_ms = loud_frames * FRAME_MS;
        if speech_ms < self.settings.min_speech_ms {
            audio.fill(0.0);
            events.push(Endpoint::TooShort);
            return;
        }
        let post_roll = (self.settings.post_roll_ms as usize) * crate::resample::RATE as usize / 1000;
        let keep = (last_loud_end + post_roll).min(audio.len());
        audio[keep..].fill(0.0);
        audio.truncate(keep);
        events.push(Endpoint::Utterance(Utterance::new(audio, start_ms, speech_ms)));
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A quiet room's hiss.
    pub fn hiss(ms: u32, seed: &mut u32) -> Vec<f32> {
        (0..ms * 16)
            .map(|_| {
                *seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((*seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5) * 0.004
            })
            .collect()
    }

    /// Something voice-like: a low tone with overtones, at about -23 dBFS.
    pub fn voice(ms: u32) -> Vec<f32> {
        (0..ms * 16)
            .map(|i| {
                let t = i as f32 / 16_000.0;
                0.05 * (2.0 * std::f32::consts::PI * 140.0 * t).sin()
                    + 0.03 * (2.0 * std::f32::consts::PI * 280.0 * t).sin()
                    + 0.02 * (2.0 * std::f32::consts::PI * 560.0 * t).sin()
            })
            .collect()
    }

    fn run(mode: Mode, settings: Endpointing, parts: &[(bool, u32)]) -> Vec<Endpoint> {
        let mut seed = 7;
        let mut endpointer = Endpointer::new(mode, settings);
        let mut events = Vec::new();
        for &(speaking, ms) in parts {
            let audio = if speaking { voice(ms) } else { hiss(ms, &mut seed) };
            for piece in audio.chunks(1600) {
                events.extend(endpointer.push(piece));
            }
        }
        events.extend(endpointer.finish());
        events.retain(|event| !matches!(event, Endpoint::Level(_)));
        events
    }

    fn utterances(events: &[Endpoint]) -> Vec<(u64, u64, u32)> {
        events
            .iter()
            .filter_map(|event| match event {
                Endpoint::Utterance(u) => Some((u.start_ms, u.end_ms, u.speech_ms)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn one_utterance_ends_at_a_pause() {
        let events = run(Mode::Tap, Endpointing::default(), &[(false, 500), (true, 1000), (false, 1500)]);
        let found = utterances(&events);
        assert_eq!(found.len(), 1, "{events:?}");
        let (start, end, speech) = found[0];
        // From the pre-roll before the speech to the post-roll after it.
        assert!((150..=260).contains(&start), "starts at {start}");
        assert!((1850..=1950).contains(&end), "ends at {end}");
        assert!((960..=1020).contains(&speech), "{speech} ms of speech");
        assert_eq!(events.last(), Some(&Endpoint::Done));
    }

    #[test]
    fn a_click_is_not_speech() {
        let events = run(Mode::Tap, Endpointing::default(), &[(false, 500), (true, 80), (false, 1200)]);
        assert!(events.contains(&Endpoint::TooShort), "{events:?}");
        assert!(utterances(&events).is_empty());
    }

    #[test]
    fn nothing_heard() {
        let events = run(Mode::Tap, Endpointing::default(), &[(false, 7000)]);
        assert_eq!(events, [Endpoint::NothingHeard, Endpoint::Done]);
    }

    #[test]
    fn live_cuts_a_stream() {
        let parts = [(false, 500), (true, 800), (false, 1500), (true, 600), (false, 9000)];
        let events = run(Mode::Continuous, Endpointing::live(), &parts);
        assert_eq!(utterances(&events).len(), 2, "{events:?}");
        assert!(!events.contains(&Endpoint::NothingHeard));
    }

    #[test]
    fn hold_ends_on_release_only() {
        let mut seed = 3;
        let mut endpointer = Endpointer::new(Mode::Hold, Endpointing::default());
        let mut events = Vec::new();
        for part in [hiss(500, &mut seed), voice(500), hiss(1500, &mut seed), voice(400)] {
            events.extend(endpointer.push(&part));
        }
        assert!(utterances(&events).is_empty(), "a pause doesn't end a hold");
        events.extend(endpointer.release());
        let found = utterances(&events);
        assert_eq!(found.len(), 1);
        assert!((850..=950).contains(&found[0].2), "{} ms of speech", found[0].2);
    }

    #[test]
    fn long_speech_is_cut() {
        let settings = Endpointing { max_utterance_ms: 3000, ..Endpointing::default() };
        let events = run(Mode::Continuous, settings, &[(false, 500), (true, 7000), (false, 1000)]);
        assert!(utterances(&events).len() >= 2, "{events:?}");
        assert!(utterances(&events).iter().all(|(start, end, _)| end - start <= 3000));
    }
}
