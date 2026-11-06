//! WAV files through the whole pipeline, as a microphone's audio would go: resampled, cut into
//! utterances, recognized by the fixture recognizer from the file's transcripts, and settled.

use shama::engine::FixtureRecognizer;
use shama::host::Host;
use shama::listen::{Endpointing, Mode};
use shama::wav::{self, Transcript, Wav};
use shama::{
    ArgValue, Call, Compiled, Language, Listener, ListenerEvent, ListenerOptions, Outcome, SettleOptions, Turn,
    Vocabulary,
};
use std::collections::BTreeMap;
use std::sync::Arc;

const RATE: u32 = 48_000;

fn compiled() -> Arc<Compiled> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/vocabulary.json");
    let vocabulary: Vocabulary = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    Arc::new(vocabulary.compile().unwrap())
}

/// A recording: quiet stretches and voice-like ones, each voiced stretch saying a text.
fn recording(parts: &[(u32, Option<&str>)]) -> Wav {
    let mut samples = Vec::new();
    let mut transcripts = Vec::new();
    let mut seed = 11u32;
    for &(ms, said) in parts {
        let start_ms = samples.len() as u64 * 1000 / RATE as u64;
        for i in 0..ms as usize * RATE as usize / 1000 {
            samples.push(match said {
                Some(_) => {
                    let t = i as f32 / RATE as f32;
                    let tone = |hz: f32| (2.0 * std::f32::consts::PI * hz * t).sin();
                    0.05 * tone(140.0) + 0.03 * tone(280.0) + 0.02 * tone(560.0)
                }
                None => {
                    seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    ((seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5) * 0.004
                }
            });
        }
        if let Some(text) = said {
            transcripts.push(Transcript {
                start_ms,
                end_ms: start_ms + ms as u64,
                text: text.into(),
                confidence: None,
            });
        }
    }
    // Through a file and back, as tests and tools hand them over.
    wav::read(&wav::write(&Wav { rate: RATE, samples, transcripts })).unwrap()
}

fn turn(language: Language) -> Turn {
    Turn { language, contexts: vec!["reading".into()], state: BTreeMap::new(), pending: None, app_speaking: false }
}

fn listener(wav: &Wav, mode: Mode, language: Language, transcripts: bool) -> Listener {
    let endpointing = if mode == Mode::Continuous { Endpointing::live() } else { Endpointing::default() };
    let options = ListenerOptions {
        mode,
        endpointing,
        input_rate: wav.rate,
        settle: SettleOptions { partial: mode != Mode::Continuous, ..SettleOptions::default() },
        transcripts,
        ..ListenerOptions::default()
    };
    Listener::new(compiled(), Box::new(FixtureRecognizer::new(wav.transcripts.clone())), turn(language), options)
}

/// Feeds audio in 10 ms pieces, as a microphone delivers it.
fn feed(listener: &mut Listener, samples: &[f32]) -> Vec<ListenerEvent> {
    let mut events: Vec<ListenerEvent> =
        samples.chunks(RATE as usize / 100).flat_map(|piece| listener.push(piece)).collect();
    events.retain(|event| !matches!(event, ListenerEvent::Level { .. }));
    events
}

fn outcomes(events: &[ListenerEvent]) -> Vec<Option<Outcome>> {
    events
        .iter()
        .filter_map(|event| match event {
            ListenerEvent::Settled { settled, .. } => Some(settled.outcome.clone()),
            _ => None,
        })
        .collect()
}

fn call(tool: &str, args: &[(&str, ArgValue)]) -> Call {
    Call { tool: tool.into(), args: args.iter().map(|(name, value)| (name.to_string(), value.clone())).collect() }
}

#[test]
fn push_to_talk() {
    let wav = recording(&[(500, None), (1000, Some("lies das dritte Kapitel von Faust")), (1500, None)]);
    let mut listener = listener(&wav, Mode::Tap, Language::De, false);
    let mut events = feed(&mut listener, &wav.samples);
    events.extend(listener.finish());
    let open = call("open", &[("book", ArgValue::Text("faust".into())), ("chapter", ArgValue::Number(3))]);
    assert_eq!(outcomes(&events), [Some(Outcome::Call { calls: vec![open] })]);
    assert_eq!(events.first(), Some(&ListenerEvent::Speech));
    assert_eq!(events.last(), Some(&ListenerEvent::Done));
    assert!(listener.is_done());
    // What was heard stays out of the events, kept here for a later stage until forgotten.
    let ListenerEvent::Settled { id, heard, speech_ms, .. } =
        events.iter().find(|e| matches!(e, ListenerEvent::Settled { .. })).unwrap()
    else {
        unreachable!()
    };
    assert_eq!(*heard, None);
    assert!((960..=1040).contains(speech_ms), "{speech_ms} ms");
    assert_eq!(listener.heard(*id).unwrap()[0].text, "lies das dritte Kapitel von Faust");
    listener.forget(*id);
    assert!(listener.heard(*id).is_none());
}

#[test]
fn nothing_said() {
    let wav = recording(&[(7000, None)]);
    let mut listener = listener(&wav, Mode::Tap, Language::En, false);
    let events = feed(&mut listener, &wav.samples);
    assert_eq!(events, [ListenerEvent::NothingHeard, ListenerEvent::Done]);
}

#[test]
fn live_while_the_app_speaks_and_after() {
    let wav = recording(&[
        (500, None),
        (900, Some("read Faust")),
        (1200, None),
        (600, Some("stop")),
        (1200, None),
        (900, Some("read Faust")),
        (1500, None),
    ]);
    let mut listener = listener(&wav, Mode::Continuous, Language::En, true);
    let split = 3800 * RATE as usize / 1000;
    // The app reads aloud: only interrupt tools count.
    let mut speaking = turn(Language::En);
    speaking.app_speaking = true;
    listener.set_turn(speaking);
    let mut events = feed(&mut listener, &wav.samples[..split]);
    // It stopped: everything counts again.
    listener.set_turn(turn(Language::En));
    events.extend(feed(&mut listener, &wav.samples[split..]));
    events.extend(listener.finish());
    let faust = Outcome::Call { calls: vec![call("open", &[("book", ArgValue::Text("faust".into()))])] };
    assert_eq!(outcomes(&events), [None, Some(Outcome::Call { calls: vec![call("stop", &[])] }), Some(faust)]);
    // Asked for, what was heard comes along.
    let heard: Vec<String> = events
        .iter()
        .filter_map(|event| match event {
            ListenerEvent::Settled { heard: Some(heard), .. } => Some(heard[0].text.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(heard, ["read Faust", "stop", "read Faust"]);
}

#[test]
fn events_as_json() {
    let event = ListenerEvent::Settled {
        id: 1,
        recognizer: "fixture".into(),
        speech_ms: 900,
        recognize_ms: 12,
        settled: shama::Settled {
            outcome: Some(Outcome::StopListening),
            stage: Some(shama::Stage::Deterministic),
            trail: vec![],
        },
        heard: None,
    };
    assert_eq!(
        serde_json::to_value(&event).unwrap(),
        serde_json::json!({
            "event": "settled", "id": 1, "recognizer": "fixture", "speechMs": 900, "recognizeMs": 12,
            "settled": { "outcome": { "kind": "stopListening" }, "stage": "deterministic", "trail": [] }
        })
    );
}

/// For debugging: where the audio came from, the meter in full, each utterance as it was cut – and
/// its audio kept, across listening, to be played back or saved as a WAV that is heard again.
#[test]
fn diagnostics_and_kept_audio() {
    let vocabulary = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/vocabulary.json"));
    let mut host = Host::new();
    assert_eq!(host.set_vocabulary(&vocabulary.unwrap()), "[]");
    let wav = wav::write(&recording(&[
        (500, None),
        (900, Some("read Faust")),
        (1200, None),
        (600, Some("stop")),
        (300, None),
    ]));
    let options = r#"{"mode":"continuous","language":"en","diagnostics":true,"keepAudio":true,"transcripts":true}"#;
    let events: Vec<serde_json::Value> = serde_json::from_str(&host.listen_wav(options, &wav, None).unwrap()).unwrap();
    let named = |name: &str| events.iter().filter(|e| e["event"] == name).collect::<Vec<_>>();
    assert_eq!(named("input")[0]["input"]["kind"], "file");
    assert_eq!(named("input")[0]["input"]["rate"], RATE);
    assert!(named("level").is_empty());
    let meters = named("meter");
    assert!(meters.len() > 40 && meters.iter().any(|m| m["phase"] == "speaking"), "{} meters", meters.len());
    let utterances = named("utterance");
    assert_eq!(utterances.len(), 2);
    assert_eq!((utterances[0]["cut"].as_str(), utterances[1]["cut"].as_str()), (Some("pause"), Some("end")));
    assert!(utterances.iter().all(|u| u["kept"] == true));
    let settled = named("settled");
    assert_eq!(settled[0]["id"], utterances[0]["id"]);
    assert!(settled[0]["recognizeMs"].is_u64());

    // Kept after listening ends, ids going on; the WAV says what was heard in it.
    host.stop();
    let first = utterances[0]["id"].as_u64().unwrap();
    let saved = wav::read(&host.recording_wav(first).unwrap()).unwrap();
    assert_eq!(saved.rate, 16_000);
    assert_eq!(saved.transcripts[0].text, "read Faust");
    assert!((1200..1700).contains(&(saved.samples.len() * 1000 / 16_000)), "{} samples", saved.samples.len());
    let again: Vec<serde_json::Value> = serde_json::from_str(&host.listen_wav(options, &wav, None).unwrap()).unwrap();
    let ids: Vec<u64> = again.iter().filter(|e| e["event"] == "utterance").map(|e| e["id"].as_u64().unwrap()).collect();
    assert_eq!(ids, [first + 2, first + 3]);
    assert!(host.recording(first).is_some(), "eight are kept");

    // Listening without keeping audio wipes what was kept; without diagnostics, a level only.
    let plain = r#"{"mode":"continuous","language":"en"}"#;
    let events: Vec<serde_json::Value> = serde_json::from_str(&host.listen_wav(plain, &wav, None).unwrap()).unwrap();
    assert!(host.recording(first).is_none() && host.recording(first + 3).is_none());
    assert!(events.iter().any(|e| e["event"] == "level"));
    assert!(!events.iter().any(|e| ["meter", "utterance", "input"].contains(&e["event"].as_str().unwrap())));
}
