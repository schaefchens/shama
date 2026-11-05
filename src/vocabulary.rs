//! An app's vocabulary: its tools, the phrases people say for them in each language, and the
//! named values those phrases take – a book, a speed. Checked as a whole, then compiled for the
//! matcher, the recognizers' bias and the AI's tool schemas.

use crate::Language;
use crate::builtin::Builtin;
use crate::contract::ArgValue;
use crate::normalize::normalize;
use crate::pattern::{self, Node, Piece};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;

/// Texts by language code.
pub type Localized<T> = BTreeMap<String, T>;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Vocabulary {
    pub tools: Vec<Tool>,
    /// Lists of named values, by name: `{ "books": [{ "id": "PSA", "say": { "de": ["Psalm", "Psalmen"] } }] }`.
    #[serde(default)]
    pub values: BTreeMap<String, Vec<Value>>,
    /// The app's own phrases for Shama's built-in words – yes, no, cancel, stopListening – beside Shama's.
    #[serde(default)]
    pub builtins: BTreeMap<String, Localized<Vec<String>>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Tool {
    /// Letters, digits, `_` and `-`, as AI providers allow for tool names.
    pub id: String,
    /// What it does, for the AI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub args: BTreeMap<String, Arg>,
    /// Where it is offered; none means everywhere.
    #[serde(default)]
    pub contexts: Vec<String>,
    /// Consequential: always asked back before it acts.
    #[serde(default)]
    pub confirm: bool,
    /// Whether an AI may call it.
    #[serde(default = "yes")]
    pub ai: bool,
    /// Matched while the app speaks, in LIVE.
    #[serde(default)]
    pub interrupt: bool,
    #[serde(default)]
    pub phrases: Vec<Phrase>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Arg {
    #[serde(rename = "type")]
    pub kind: ArgKind,
    /// The value list, for `value` arguments.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub of: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<i64>,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The question when it is missing: `{ "de": "Welches Kapitel?" }`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub ask: Localized<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArgKind {
    Number,
    Value,
    Text,
    Boolean,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Phrase {
    /// Patterns by language: `{ "de": ["[lies] {book} [kapitel] {chapter}"] }`.
    pub say: Localized<Vec<String>>,
    /// Arguments the phrase itself sets: "next verse" → `{ "step": "verse+1" }`.
    #[serde(default)]
    pub args: BTreeMap<String, ArgValue>,
    /// Narrows where the phrase is offered, within its tool's contexts.
    #[serde(default)]
    pub contexts: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Value {
    pub id: String,
    #[serde(default)]
    pub say: Localized<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

fn yes() -> bool {
    true
}

/// Something wrong in a vocabulary, and where.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Problem {
    pub path: String,
    pub message: String,
}

/// Every problem in a vocabulary that keeps it from being used.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VocabularyError {
    pub problems: Vec<Problem>,
}

impl fmt::Display for VocabularyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (i, problem) in self.problems.iter().enumerate() {
            if i > 0 {
                writeln!(f)?;
            }
            write!(f, "{}: {}", problem.path, problem.message)?;
        }
        Ok(())
    }
}

impl std::error::Error for VocabularyError {}

/// A vocabulary checked and prepared for matching.
#[derive(Debug)]
pub struct Compiled {
    pub(crate) tools: Vec<CompiledTool>,
    pub(crate) lists: BTreeMap<String, CompiledList>,
    pub(crate) builtins: BTreeMap<(Language, Builtin), Vec<Vec<String>>>,
    pub(crate) languages: BTreeSet<Language>,
}

#[derive(Debug)]
pub(crate) struct CompiledTool {
    pub id: String,
    pub description: Option<String>,
    pub args: BTreeMap<String, Arg>,
    /// In the order they were declared, for asking.
    pub arg_order: Vec<String>,
    pub contexts: Vec<String>,
    pub confirm: bool,
    pub ai: bool,
    pub interrupt: bool,
    pub phrases: Vec<CompiledPhrase>,
}

#[derive(Debug)]
pub(crate) struct CompiledPhrase {
    pub language: Language,
    pub nodes: Vec<Node>,
    /// The words as the app wrote them, for recognizers' bias.
    pub written: Vec<Node>,
    pub args: BTreeMap<String, ArgValue>,
    pub contexts: Vec<String>,
}

#[derive(Debug)]
pub(crate) struct CompiledList {
    pub values: Vec<CompiledValue>,
}

#[derive(Debug)]
pub(crate) struct CompiledValue {
    pub id: String,
    pub description: Option<String>,
    /// Normalized words of each spoken form, by language.
    pub forms: BTreeMap<Language, Vec<Vec<String>>>,
    /// The forms as the app wrote them.
    pub said: BTreeMap<Language, Vec<String>>,
}

impl Vocabulary {
    pub fn from_json(json: &str) -> Result<Vocabulary, VocabularyError> {
        serde_json::from_str(json).map_err(|error| VocabularyError {
            problems: vec![Problem { path: String::new(), message: error.to_string() }],
        })
    }

    /// Checks the whole vocabulary and prepares it, or lists every problem.
    pub fn compile(&self) -> Result<Compiled, VocabularyError> {
        let mut problems = Vec::new();
        let mut problem = |path: String, message: String| problems.push(Problem { path, message });
        let mut languages = BTreeSet::new();

        let mut lists = BTreeMap::new();
        for (name, values) in &self.values {
            let mut ids = BTreeSet::new();
            let mut compiled = Vec::new();
            for (i, value) in values.iter().enumerate() {
                let path = format!("values.{name}[{i}]");
                if value.id.is_empty() {
                    problem(format!("{path}.id"), "an empty id".into());
                }
                if !ids.insert(value.id.as_str()) {
                    problem(format!("{path}.id"), format!("'{}' is in the list twice", value.id));
                }
                let mut forms = BTreeMap::new();
                let mut said = BTreeMap::new();
                for (code, texts) in &value.say {
                    let Some(language) = language_of(code, &format!("{path}.say.{code}"), &mut problem) else {
                        continue;
                    };
                    languages.insert(language);
                    let mut words = Vec::new();
                    for (j, text) in texts.iter().enumerate() {
                        let normalized = normalize(language, text);
                        if normalized.is_empty() {
                            problem(format!("{path}.say.{code}[{j}]"), "says nothing".into());
                        } else if !words.contains(&normalized) {
                            words.push(normalized);
                        }
                    }
                    forms.insert(language, words);
                    said.insert(language, texts.clone());
                }
                compiled.push(CompiledValue {
                    id: value.id.clone(),
                    description: value.description.clone(),
                    forms,
                    said,
                });
            }
            lists.insert(name.clone(), CompiledList { values: compiled });
        }

        let mut tools = Vec::new();
        let mut tool_ids = BTreeSet::new();
        for (t, tool) in self.tools.iter().enumerate() {
            let path = format!("tools[{t}]");
            if tool.id.is_empty()
                || tool.id.len() > 64
                || !tool.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            {
                problem(format!("{path}.id"), format!("'{}' isn't a tool id: 1–64 letters, digits, _ or -", tool.id));
            }
            if crate::assistant::RESERVED_TOOLS.contains(&tool.id.as_str()) {
                problem(format!("{path}.id"), format!("'{}' is Shama's own", tool.id));
            }
            if !tool_ids.insert(tool.id.as_str()) {
                problem(format!("{path}.id"), format!("'{}' is a tool twice", tool.id));
            }
            if tool.confirm && tool.interrupt {
                problem(path.clone(), "an interrupt tool can't wait for a confirmation".into());
            }
            for context in &tool.contexts {
                if context.is_empty() {
                    problem(format!("{path}.contexts"), "an empty context".into());
                }
            }
            for (name, arg) in &tool.args {
                let arg_path = format!("{path}.args.{name}");
                if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    problem(arg_path.clone(), "an argument's name: letters, digits and _ only".into());
                }
                match (arg.kind, &arg.of) {
                    (ArgKind::Value, None) => {
                        problem(arg_path.clone(), "a value argument names its list in 'of'".into())
                    }
                    (ArgKind::Value, Some(list)) if !lists.contains_key(list) => {
                        problem(format!("{arg_path}.of"), format!("no value list '{list}'"))
                    }
                    (kind, Some(_)) if kind != ArgKind::Value => {
                        problem(format!("{arg_path}.of"), "only value arguments name a list".into())
                    }
                    _ => {}
                }
                if let (Some(min), Some(max)) = (arg.min, arg.max)
                    && min > max
                {
                    problem(arg_path.clone(), format!("min {min} is above max {max}"));
                }
                if arg.kind != ArgKind::Number && (arg.min.is_some() || arg.max.is_some()) {
                    problem(arg_path.clone(), "only number arguments have min and max".into());
                }
                for code in arg.ask.keys() {
                    language_of(code, &format!("{arg_path}.ask.{code}"), &mut problem);
                }
            }
            let mut phrases = Vec::new();
            for (p, phrase) in tool.phrases.iter().enumerate() {
                let phrase_path = format!("{path}.phrases[{p}]");
                for (name, value) in &phrase.args {
                    match tool.args.get(name) {
                        None => problem(
                            format!("{phrase_path}.args.{name}"),
                            format!("{} has no argument '{name}'", tool.id),
                        ),
                        Some(arg) => {
                            if let Err(message) = check_value(arg, value, &lists) {
                                problem(format!("{phrase_path}.args.{name}"), message);
                            }
                        }
                    }
                }
                for context in &phrase.contexts {
                    if !tool.contexts.is_empty() && !tool.contexts.contains(context) {
                        problem(
                            format!("{phrase_path}.contexts"),
                            format!("'{context}' isn't one of {}'s contexts", tool.id),
                        );
                    }
                }
                for (code, patterns) in &phrase.say {
                    let Some(language) = language_of(code, &format!("{phrase_path}.say.{code}"), &mut problem) else {
                        continue;
                    };
                    languages.insert(language);
                    for (j, text) in patterns.iter().enumerate() {
                        let pattern_path = format!("{phrase_path}.say.{code}[{j}]");
                        let nodes = match pattern::parse(language, text) {
                            Ok(nodes) => nodes,
                            Err(message) => {
                                problem(pattern_path, message);
                                continue;
                            }
                        };
                        let slots = pattern::slots(&nodes);
                        for slot in &slots {
                            match tool.args.get(slot) {
                                None => problem(pattern_path.clone(), format!("{} has no argument '{slot}'", tool.id)),
                                Some(arg) if arg.kind == ArgKind::Boolean => problem(
                                    pattern_path.clone(),
                                    format!("'{{{slot}}}' is a flag: phrases set it, as args"),
                                ),
                                Some(_) if phrase.args.contains_key(slot) => problem(
                                    pattern_path.clone(),
                                    format!("'{{{slot}}}' is also set in the phrase's args"),
                                ),
                                Some(_) => {}
                            }
                        }
                        if let Some(message) = text_slot_problem(&nodes, &tool.args) {
                            problem(pattern_path.clone(), message);
                        }
                        let written = pattern::parse_as_written(text).unwrap_or_default();
                        phrases.push(CompiledPhrase {
                            language,
                            nodes,
                            written,
                            args: phrase.args.clone(),
                            contexts: phrase.contexts.clone(),
                        });
                    }
                }
            }
            tools.push(CompiledTool {
                id: tool.id.clone(),
                description: tool.description.clone(),
                args: tool.args.clone(),
                arg_order: tool.args.keys().cloned().collect(),
                contexts: tool.contexts.clone(),
                confirm: tool.confirm,
                ai: tool.ai,
                interrupt: tool.interrupt,
                phrases,
            });
        }

        let mut builtins = BTreeMap::new();
        for builtin in Builtin::ALL {
            for language in Language::ALL {
                let words: Vec<Vec<String>> =
                    builtin.phrases(language).iter().map(|phrase| normalize(language, phrase)).collect();
                builtins.insert((language, builtin), words);
            }
        }
        for (name, by_language) in &self.builtins {
            let path = format!("builtins.{name}");
            let Some(builtin) = Builtin::from_name(name) else {
                problem(path, "not one of yes, no, cancel, stopListening".into());
                continue;
            };
            for (code, phrases) in by_language {
                let Some(language) = language_of(code, &format!("{path}.{code}"), &mut problem) else { continue };
                let words = builtins.entry((language, builtin)).or_default();
                for phrase in phrases {
                    let normalized = normalize(language, phrase);
                    if !normalized.is_empty() && !words.contains(&normalized) {
                        words.push(normalized);
                    }
                }
            }
        }

        check_overlaps(&tools, &builtins, &mut problems);

        if problems.is_empty() {
            Ok(Compiled { tools, lists, builtins, languages })
        } else {
            Err(VocabularyError { problems })
        }
    }
}

fn language_of(code: &str, path: &str, problem: &mut impl FnMut(String, String)) -> Option<Language> {
    match Language::from_code(code) {
        Some(language) => Some(language),
        None => {
            problem(path.to_string(), format!("Shama has no language data for '{code}'"));
            None
        }
    }
}

/// Whether a value fits an argument: its type, range, list.
pub(crate) fn check_value(arg: &Arg, value: &ArgValue, lists: &BTreeMap<String, CompiledList>) -> Result<(), String> {
    match (arg.kind, value) {
        (ArgKind::Number, ArgValue::Number(n)) => {
            if arg.min.is_some_and(|min| *n < min) || arg.max.is_some_and(|max| *n > max) {
                return Err(format!(
                    "{n} is outside {}–{}",
                    arg.min.map_or("…".into(), |m| m.to_string()),
                    arg.max.map_or("…".into(), |m| m.to_string())
                ));
            }
            Ok(())
        }
        (ArgKind::Value, ArgValue::Text(id)) => {
            let list = arg.of.as_ref().and_then(|name| lists.get(name));
            if list.is_some_and(|list| list.values.iter().any(|value| &value.id == id)) {
                Ok(())
            } else {
                Err(format!("'{id}' isn't in {}", arg.of.as_deref().unwrap_or("its list")))
            }
        }
        (ArgKind::Text, ArgValue::Text(_)) | (ArgKind::Boolean, ArgValue::Flag(_)) => Ok(()),
        (kind, _) => Err(format!("not a {}", format!("{kind:?}").to_lowercase())),
    }
}

/// A text slot takes the words between its neighbours, so it can't sit beside another slot.
fn text_slot_problem(nodes: &[Node], args: &BTreeMap<String, Arg>) -> Option<String> {
    for way in pattern::expand(nodes, 64) {
        for pair in way.windows(2) {
            if let [Piece::Slot(a), Piece::Slot(b)] = pair {
                let is_text = |name: &String| args.get(name).is_some_and(|arg| arg.kind == ArgKind::Text);
                if is_text(a) || is_text(b) {
                    return Some(format!(
                        "the text slot '{{{}}}' sits beside another slot",
                        if is_text(a) { a } else { b }
                    ));
                }
            }
        }
    }
    None
}

/// One phrase meaning two calls is an error: in the same language, where both are offered, the
/// same words – or the same words around slots of the same kind – would have to pick one.
fn check_overlaps(
    tools: &[CompiledTool],
    builtins: &BTreeMap<(Language, Builtin), Vec<Vec<String>>>,
    problems: &mut Vec<Problem>,
) {
    type Shape = (Language, Vec<String>);
    let mut seen: HashMap<Shape, Vec<(usize, usize, Vec<String>)>> = HashMap::new();
    for (t, tool) in tools.iter().enumerate() {
        for (p, phrase) in tool.phrases.iter().enumerate() {
            let contexts = if phrase.contexts.is_empty() { tool.contexts.clone() } else { phrase.contexts.clone() };
            for way in pattern::expand(&phrase.nodes, 256) {
                let shape: Vec<String> = way
                    .iter()
                    .map(|piece| match piece {
                        Piece::Word(word) => word.clone(),
                        Piece::Slot(name) => match tool.args.get(name) {
                            Some(Arg { kind: ArgKind::Value, of: Some(list), .. }) => format!("{{value:{list}}}"),
                            Some(arg) => format!("{{{:?}}}", arg.kind).to_lowercase(),
                            None => "{?}".into(),
                        },
                    })
                    .collect();
                let key = (phrase.language, shape);
                let entry = seen.entry(key.clone()).or_default();
                for (other_t, other_p, other_contexts) in entry.iter() {
                    let other_tool = &tools[*other_t];
                    let other_phrase = &other_tool.phrases[*other_p];
                    let same_call = *other_t == t && other_phrase.args == phrase.args;
                    let overlap = (contexts.is_empty() && other_contexts.is_empty())
                        || contexts.iter().any(|context| other_contexts.contains(context));
                    if !same_call && overlap {
                        problems.push(Problem {
                            path: format!("tools[{t}].phrases[{p}]"),
                            message: format!(
                                "'{}' ({}) also means {}",
                                key.1.join(" "),
                                key.0,
                                if *other_t == t {
                                    format!("{} with other args", tool.id)
                                } else {
                                    other_tool.id.clone()
                                }
                            ),
                        });
                    }
                }
                entry.push((t, p, contexts.clone()));
            }
        }
    }
    // A tool's phrase that is one of the built-in words would never be reached.
    for (t, tool) in tools.iter().enumerate() {
        for (p, phrase) in tool.phrases.iter().enumerate() {
            for way in pattern::expand(&phrase.nodes, 256) {
                let words: Option<Vec<String>> = way
                    .iter()
                    .map(|piece| match piece {
                        Piece::Word(word) => Some(word.clone()),
                        Piece::Slot(_) => None,
                    })
                    .collect();
                let Some(words) = words else { continue };
                for builtin in [Builtin::StopListening, Builtin::Yes, Builtin::No, Builtin::Cancel] {
                    if builtins.get(&(phrase.language, builtin)).is_some_and(|phrases| phrases.contains(&words)) {
                        problems.push(Problem {
                            path: format!("tools[{t}].phrases[{p}]"),
                            message: format!("'{}' is Shama's built-in '{}'", words.join(" "), builtin.name()),
                        });
                    }
                }
            }
        }
    }
}

impl Compiled {
    pub fn languages(&self) -> impl Iterator<Item = Language> + '_ {
        self.languages.iter().copied()
    }

    pub(crate) fn tool(&self, id: &str) -> Option<&CompiledTool> {
        self.tools.iter().find(|tool| tool.id == id)
    }

    /// Phrases to bias a recognizer toward, for the tools offered in `contexts`: the value lists'
    /// names and the words around the slots, those of the contexts in front first.
    pub fn bias(&self, language: Language, contexts: &[String]) -> Vec<String> {
        let mut ordered: Vec<&CompiledTool> = self.tools.iter().collect();
        ordered.sort_by_key(|tool| priority(&tool.contexts, contexts));
        let mut phrases: Vec<String> = Vec::new();
        let mut push = |phrase: String| {
            if !phrase.is_empty() && !phrases.contains(&phrase) {
                phrases.push(phrase);
            }
        };
        for tool in &ordered {
            if priority(&tool.contexts, contexts).is_none() {
                continue;
            }
            for phrase in tool.phrases.iter().filter(|phrase| phrase.language == language) {
                for way in pattern::expand(&phrase.written, 16) {
                    let mut run = Vec::new();
                    for piece in way {
                        match piece {
                            Piece::Word(word) => run.push(word),
                            Piece::Slot(_) => push(std::mem::take(&mut run).join(" ")),
                        }
                    }
                    push(run.join(" "));
                }
            }
            for arg in tool.args.values() {
                if let Some(list) = arg.of.as_ref().and_then(|name| self.lists.get(name)) {
                    for value in &list.values {
                        for said in value.said.get(&language).into_iter().flatten() {
                            push(said.clone());
                        }
                    }
                }
            }
        }
        phrases
    }
}

/// Where a tool or phrase stands for the app's contexts: the index of the first of them it is
/// offered in, those offered everywhere after them; `None` where it isn't offered.
pub(crate) fn priority(offered_in: &[String], contexts: &[String]) -> Option<usize> {
    if offered_in.is_empty() {
        return Some(contexts.len());
    }
    contexts.iter().position(|context| offered_in.contains(context))
}

#[cfg(test)]
pub(crate) mod tests_support {
    use super::Vocabulary;
    use serde_json::json;

    pub fn reader() -> Vocabulary {
        serde_json::from_value(json!({
            "tools": [
                {
                    "id": "open",
                    "description": "Opens a book at a chapter and verse",
                    "args": {
                        "book": { "type": "value", "of": "books", "required": true },
                        "chapter": { "type": "number", "min": 1, "max": 150, "required": true,
                                     "ask": { "en": "Which chapter?", "de": "Welches Kapitel?" } },
                        "verse": { "type": "number", "min": 1, "max": 176 }
                    },
                    "phrases": [
                        { "say": {
                            "en": ["[read|open] {book} [chapter] {chapter} [verse] {verse}", "[read|open] {book} [chapter] {chapter}", "[read|open] {book}"],
                            "de": ["[lies|öffne] {book} [kapitel] {chapter} [vers] {verse}", "[lies|öffne] {book} [kapitel] {chapter}", "[lies|öffne] {book}"]
                        } },
                        { "say": { "en": ["verse {verse}"], "de": ["vers {verse}"] } }
                    ]
                },
                {
                    "id": "move",
                    "args": { "step": { "type": "value", "of": "steps", "required": true } },
                    "contexts": ["reading"],
                    "interrupt": true,
                    "phrases": [
                        { "say": { "en": ["next [verse]"], "de": ["(nächster|weiter) [vers]"] }, "args": { "step": "verse+1" } },
                        { "say": { "en": ["previous [verse]", "back"], "de": ["(vorheriger|zurück) [vers]"] }, "args": { "step": "verse-1" } }
                    ]
                },
                {
                    "id": "select",
                    "args": { "index": { "type": "number", "min": 1, "max": 9 } },
                    "contexts": ["library"],
                    "phrases": [ { "say": { "en": ["next"], "de": ["nächster"] } } ]
                },
                { "id": "stop", "interrupt": true, "phrases": [ { "say": { "en": ["stop"], "de": ["stopp", "halt"] } } ] },
                { "id": "whereAmI", "phrases": [ { "say": { "en": ["where am i"], "de": ["wo bin ich"] } } ] },
                {
                    "id": "search",
                    "args": { "query": { "type": "text", "required": true } },
                    "phrases": [ { "say": { "en": ["search [for] {query}"], "de": ["suche [nach] {query}"] } } ]
                },
                {
                    "id": "deleteBookmarks",
                    "confirm": true,
                    "ai": false,
                    "phrases": [ { "say": { "en": ["delete [all] bookmarks"], "de": ["lösche [alle] lesezeichen"] } } ]
                }
            ],
            "values": {
                "books": [
                    { "id": "PSA", "say": { "en": ["Psalm", "Psalms"], "de": ["Psalm", "Psalmen"] } },
                    { "id": "JHN", "say": { "en": ["John", "Gospel of John"], "de": ["Johannes", "Johannesevangelium"] } },
                    { "id": "JON", "say": { "en": ["Jonah"], "de": ["Jona"] } },
                    { "id": "1JN", "say": { "en": ["First John", "1 John"], "de": ["Erster Johannes", "1. Johannes"] } }
                ],
                "steps": [ { "id": "verse+1" }, { "id": "verse-1" } ]
            }
        }))
        .unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::reader;
    use super::*;
    use serde_json::json;

    #[test]
    fn a_good_vocabulary_compiles() {
        let compiled = reader().compile().unwrap();
        assert_eq!(compiled.languages().collect::<Vec<_>>(), [Language::En, Language::De]);
        let bias = compiled.bias(Language::De, &["reading".to_string()]);
        assert!(bias.contains(&"nächster vers".to_string()), "{bias:?}");
        assert!(bias.contains(&"Johannesevangelium".to_string()));
    }

    #[test]
    fn every_problem_with_its_path() {
        let vocabulary: Vocabulary = serde_json::from_value(json!({
            "tools": [
                { "id": "open now", "args": { "book": { "type": "value" } }, "phrases": [ { "say": { "xx": ["a"] } } ] },
                { "id": "go", "args": { "n": { "type": "number", "min": 5, "max": 1 } },
                  "phrases": [ { "say": { "en": ["go {m}", "[go"] }, "args": { "x": 1 } } ] },
                { "id": "go", "confirm": true, "interrupt": true }
            ]
        }))
        .unwrap();
        let error = vocabulary.compile().unwrap_err();
        let paths: Vec<&str> = error.problems.iter().map(|p| p.path.as_str()).collect();
        assert!(paths.contains(&"tools[0].id"), "{error}");
        assert!(paths.contains(&"tools[0].args.book"), "{error}");
        assert!(paths.contains(&"tools[0].phrases[0].say.xx"), "{error}");
        assert!(paths.contains(&"tools[1].args.n"), "{error}");
        assert!(paths.contains(&"tools[1].phrases[0].args.x"), "{error}");
        assert!(paths.contains(&"tools[1].phrases[0].say.en[0]"), "{error}");
        assert!(paths.contains(&"tools[1].phrases[0].say.en[1]"), "{error}");
        assert!(paths.contains(&"tools[2].id"), "{error}");
        assert!(paths.contains(&"tools[2]"), "{error}");
    }

    #[test]
    fn one_phrase_two_meanings() {
        let vocabulary: Vocabulary = serde_json::from_value(json!({
            "tools": [
                { "id": "pause", "phrases": [ { "say": { "en": ["(hold|wait)"] } } ] },
                { "id": "stop", "phrases": [ { "say": { "en": ["hold"] } } ] },
                { "id": "next", "contexts": ["a"], "phrases": [ { "say": { "en": ["next"] } } ] },
                { "id": "forward", "contexts": ["b"], "phrases": [ { "say": { "en": ["next"] } } ] },
                { "id": "bye", "phrases": [ { "say": { "en": ["goodbye"] } } ] }
            ]
        }))
        .unwrap();
        let error = vocabulary.compile().unwrap_err();
        assert_eq!(error.problems.len(), 2, "{error}");
        assert!(error.problems[0].message.contains("also means pause"), "{error}");
        assert!(error.problems[1].message.contains("built-in 'stopListening'"), "{error}");
    }
}
