//! Shama settles what people say into calls to an app's tools – deterministically first, then by
//! the device's best effort, and only then by an AI given the tools the moment needs.

mod assistant;
mod builtin;
mod contract;
mod language;
mod matcher;
pub mod normalize;
pub mod numbers;
pub mod pattern;
mod vocabulary;

pub use assistant::{AiReply, AiRequest, Checked, NOT_ADDRESSED, ToolSpec};
pub use builtin::Builtin;
pub use contract::*;
pub use language::Language;
pub use matcher::SettleOptions;
pub use vocabulary::{Arg, ArgKind, Compiled, Localized, Phrase, Problem, Tool, Value, Vocabulary, VocabularyError};
