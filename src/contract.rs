//! What passes between Shama's parts – the core, the platforms' recognizers and the TypeScript
//! pipeline – as JSON.

use crate::Language;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// An argument's value: a number, a value's id or captured text, or a flag.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ArgValue {
    Flag(bool),
    Number(i64),
    Text(String),
}

/// A call to one of the app's tools.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Call {
    pub tool: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub args: BTreeMap<String, ArgValue>,
}

/// One reading of what was said, as a recognizer wrote it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Hypothesis {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
}

/// What a recognizer heard in one utterance: its readings, the likeliest first.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Heard {
    pub recognizer: String,
    pub hypotheses: Vec<Hypothesis>,
    #[serde(default)]
    pub speech_ms: u32,
}

/// What the app was asked, waiting for the next utterance to answer it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Pending {
    /// A call missing an argument: "Which chapter?"
    Ask { call: Call, missing: String },
    /// Calls to confirm: "Delete all bookmarks?"
    Confirm { calls: Vec<Call> },
    /// Calls to choose between: "John or Jonah?"
    Choose { candidates: Vec<Call> },
}

/// The moment an utterance is settled in.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub language: Language,
    /// The app's contexts, the one in front first: tools for them are offered, then the rest.
    #[serde(default)]
    pub contexts: Vec<String>,
    /// What the app is at – a book, a chapter – filling arguments a call leaves unsaid.
    #[serde(default)]
    pub state: BTreeMap<String, ArgValue>,
    #[serde(default)]
    pub pending: Option<Pending>,
    /// The app is speaking (LIVE): only interrupt tools are matched, strictly.
    #[serde(default)]
    pub app_speaking: bool,
}

/// What a stage settled an utterance into.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Outcome {
    Call {
        calls: Vec<Call>,
    },
    Ask {
        call: Call,
        missing: String,
    },
    Confirm {
        calls: Vec<Call>,
    },
    Unsure {
        candidates: Vec<Call>,
    },
    /// "No" or "cancel" to what was pending.
    Cancelled,
    /// The words that end a LIVE conversation.
    StopListening,
    /// Speech the AI found not addressed to the app (LIVE).
    Ignored,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Deterministic,
    Local,
    Ai,
}

/// Why a stage didn't settle an utterance, or why the next one didn't run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Why {
    NoMatch,
    LowConfidence,
    Ambiguous,
    NothingHeard,
    /// While the app speaks, only interrupt tools count.
    InterruptOnly,
    Offline,
    AiNotAllowed,
    Unavailable,
    Timeout,
    InvalidReply,
    Refused,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepOutcome {
    Resolved,
    NoMatch,
    Skipped,
    Failed,
}

/// One stage's part in settling an utterance.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Step {
    pub stage: Stage,
    pub by: String,
    pub outcome: StepOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<Why>,
    #[serde(default)]
    pub ms: u32,
}

/// What the stages on the device made of an utterance, and how.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Settled {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Outcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<Stage>,
    pub trail: Vec<Step>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_shapes() {
        let call = Call {
            tool: "open".into(),
            args: BTreeMap::from([
                ("book".into(), ArgValue::Text("PSA".into())),
                ("chapter".into(), ArgValue::Number(139)),
                ("read".into(), ArgValue::Flag(true)),
            ]),
        };
        let outcome = Outcome::Call { calls: vec![call.clone()] };
        assert_eq!(
            serde_json::to_value(&outcome).unwrap(),
            json!({"kind": "call", "calls": [{"tool": "open", "args": {"book": "PSA", "chapter": 139, "read": true}}]})
        );
        let turn: Turn = serde_json::from_value(json!({
            "language": "de",
            "contexts": ["reading"],
            "pending": {"kind": "ask", "call": {"tool": "open", "args": {"book": "PSA"}}, "missing": "chapter"},
            "appSpeaking": true
        }))
        .unwrap();
        assert_eq!(turn.language, Language::De);
        assert!(turn.app_speaking);
        assert!(matches!(turn.pending, Some(Pending::Ask { ref missing, .. }) if missing == "chapter"));
        assert_eq!(serde_json::to_value(Outcome::StopListening).unwrap(), json!({"kind": "stopListening"}));
    }
}
