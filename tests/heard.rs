//! What recognizers might hear, row by row, and what it must settle into – near misses and
//! speech not meant for the app included, which must settle into nothing that acts. The rows are
//! in tests/fixtures/heard/<language>.tsv; the vocabulary is the examples' own.

use shama::{ArgValue, Call, Heard, Hypothesis, Language, Outcome, SettleOptions, Stage, Turn, Vocabulary};
use std::collections::BTreeMap;
use std::path::Path;

fn fixtures() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures"))
}

fn expected(text: &str) -> Option<Outcome> {
    let call = |text: &str| {
        let (tool, args) = text.split_once(' ').unwrap_or((text, ""));
        let args = args
            .split("; ")
            .filter(|arg| !arg.is_empty())
            .map(|arg| {
                let (name, value) = arg.split_once('=').expect("name=value");
                let value = match value.parse() {
                    Ok(number) => ArgValue::Number(number),
                    Err(_) => ArgValue::Text(value.to_string()),
                };
                (name.to_string(), value)
            })
            .collect();
        Call { tool: tool.to_string(), args }
    };
    match text {
        "none" => None,
        "stopListening" => Some(Outcome::StopListening),
        _ => Some(match text.strip_prefix("confirm ") {
            Some(rest) => Outcome::Confirm { calls: vec![call(rest)] },
            None => Outcome::Call { calls: vec![call(text)] },
        }),
    }
}

#[test]
fn every_language_settles_what_it_hears() {
    let vocabulary: Vocabulary =
        serde_json::from_str(&std::fs::read_to_string(fixtures().join("vocabulary.json")).unwrap()).unwrap();
    let compiled = vocabulary.compile().unwrap_or_else(|error| panic!("{error}"));
    let mut failures = Vec::new();
    let mut rows = 0;
    for language in Language::ALL {
        let file = fixtures().join(format!("heard/{language}.tsv"));
        let text = std::fs::read_to_string(&file).unwrap();
        for (number, line) in text.lines().enumerate() {
            if line.starts_with('#') || line.trim().is_empty() {
                continue;
            }
            let columns: Vec<&str> = line.split('\t').collect();
            let [stage, contexts, speaking, heard, want] = columns[..] else {
                panic!("{language}.tsv:{}: five columns", number + 1);
            };
            rows += 1;
            let turn = Turn {
                language,
                contexts: if contexts == "-" { Vec::new() } else { contexts.split(',').map(String::from).collect() },
                state: BTreeMap::new(),
                pending: None,
                app_speaking: speaking == "y",
            };
            let heard = Heard {
                recognizer: "fixture".into(),
                hypotheses: vec![Hypothesis { text: heard.into(), confidence: None }],
                speech_ms: 1000,
            };
            let settled = compiled.settle(&turn, &heard, &SettleOptions::default());
            let stage_wanted = match stage {
                "1" => Some(Stage::Deterministic),
                "2" => Some(Stage::Local),
                _ => None,
            };
            let outcome_wanted = expected(want);
            if settled.outcome != outcome_wanted || settled.stage != stage_wanted {
                failures.push(format!(
                    "{language}.tsv:{} \"{}\": wanted {outcome_wanted:?} in {stage_wanted:?}, got {:?} in {:?}",
                    number + 1,
                    heard.hypotheses[0].text,
                    settled.outcome,
                    settled.stage
                ));
            }
        }
    }
    assert!(rows > 100, "{rows} rows");
    assert!(failures.is_empty(), "{} of {rows} rows:\n{}", failures.len(), failures.join("\n"));
}
