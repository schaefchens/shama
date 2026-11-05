//! The embedded models measured for docs/engines.md, where tools/bench/fetch-models.sh put them
//! (.cache/models): each hears commands from the measuring corpus (.cache/corpus). Without them,
//! as in CI, there is nothing to test.

use shama::normalize::fold;
use shama::{Language, listen::Utterance};
use shama_sherpa::{Manifest, Model};
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn manifest(id: &str, language: Language, family: &str, files: &[(&str, &str)]) -> Manifest {
    Manifest {
        id: id.into(),
        language,
        family: family.into(),
        files: files.iter().map(|(part, name)| (part.to_string(), name.to_string())).collect(),
    }
}

/// Whether a reading is close to what was said: one edit in eight letters, as docs/engines.md
/// scores – about what the matcher forgives.
fn close(language: Language, heard: &str, said: &str) -> bool {
    let (a, b): (Vec<char>, Vec<char>) =
        (fold(language, heard).chars().collect(), fold(language, said).chars().collect());
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, x) in a.iter().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, y) in b.iter().enumerate() {
            let next = (diagonal + usize::from(x != y)).min(row[j] + 1).min(row[j + 1] + 1);
            diagonal = row[j + 1];
            row[j + 1] = next;
        }
    }
    row[b.len()] <= b.len().div_ceil(8)
}

/// The corpus's first commands in a language: (16 kHz audio, what was said).
fn commands(language: Language, count: usize) -> Vec<(Vec<f32>, String)> {
    let folder = root().join(".cache/corpus").join(language.code());
    let Ok(lines) = std::fs::read_to_string(folder.join("manifest.jsonl")) else { return vec![] };
    lines
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|entry| entry["kind"] == "command")
        .take(count)
        .filter_map(|entry| {
            let bytes = std::fs::read(root().join(entry["file"].as_str()?)).ok()?;
            let wav = shama::wav::read(&bytes).ok()?;
            assert_eq!(wav.rate, 16_000);
            Some((wav.samples, entry["expected"].as_str()?.to_string()))
        })
        .collect()
}

#[test]
fn the_measured_models_hear_commands() {
    let models = [
        (
            "sherpa-onnx-nemo-ctc-fa-shenava-rizeh-v1.0-non-streaming-int8-2026-06-26",
            manifest("fa-rizeh", Language::Fa, "nemo_ctc", &[("model", "model.int8.onnx"), ("tokens", "tokens.txt")]),
        ),
        (
            "seda-v0.1",
            manifest(
                "tr-seda",
                Language::Tr,
                "online_transducer",
                &[
                    ("encoder", "encoder.int8.onnx"),
                    ("decoder", "decoder.onnx"),
                    ("joiner", "joiner.int8.onnx"),
                    ("tokens", "tokens.txt"),
                ],
            ),
        ),
        (
            "sherpa-onnx-nemo-transducer-stt_de_fastconformer_hybrid_large_pc-int8",
            manifest(
                "de-fastconformer",
                Language::De,
                "nemo_transducer",
                &[
                    ("encoder", "encoder.int8.onnx"),
                    ("decoder", "decoder.int8.onnx"),
                    ("joiner", "joiner.int8.onnx"),
                    ("tokens", "tokens.txt"),
                ],
            ),
        ),
        (
            "sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8",
            manifest(
                "en-parakeet",
                Language::En,
                "nemo_ctc",
                &[("model", "model.int8.onnx"), ("tokens", "tokens.txt")],
            ),
        ),
    ];
    let mut tested = 0;
    for (folder, manifest) in models {
        let folder = root().join(".cache/models").join(folder);
        let language = manifest.language;
        let samples = commands(language, 9);
        if !folder.is_dir() || samples.is_empty() {
            eprintln!("skipped {}: no model or corpus", manifest.id);
            continue;
        }
        let model = Model::load_as(&folder, manifest, 2).expect("the model loads");
        let mut recognizer = model.recognizer();
        let mut heard = 0;
        for (audio, said) in &samples {
            let utterance = Utterance::new(audio.clone(), 0, 0);
            let readings = recognizer.recognize(language, &[], &utterance).expect("it hears");
            let text = readings.first().map(|h| h.text.as_str()).unwrap_or("");
            if close(language, text, said) {
                heard += 1;
            } else {
                eprintln!("{}: {said:?} heard as {text:?}", recognizer.name());
            }
        }
        eprintln!("{}: {heard} of {} fixed commands close", recognizer.name(), samples.len());
        assert!(heard * 3 >= samples.len() * 2, "{}: only {heard} of {}", recognizer.name(), samples.len());
        assert!(recognizer.recognize(Language::Ar, &[], &Utterance::new(vec![0.0; 1600], 0, 0)).is_err());
        tested += 1;
    }
    eprintln!("{tested} models tested");
}
