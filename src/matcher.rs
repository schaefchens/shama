//! Stages 1 and 2: what a recognizer heard, settled against the app's vocabulary.
//!
//! Stage 1 is strict: one of the readings, whole, is one of the app's phrases – exactly, or with
//! one edit in a long one – among the tools its contexts offer, the one in front first. Stage 2
//! is looser: fillers dropped, more edits, Arabic proclitics and Turkish suffixes allowed; and a
//! phrase found inside longer speech is only ever asked back, never acted on.

use crate::Language;
use crate::builtin::{self, Builtin};
use crate::contract::{ArgValue, Call, Heard, Outcome, Pending, Settled, Stage, Step, StepOutcome, Turn, Why};
use crate::normalize::{self, Word};
use crate::numbers;
use crate::pattern::Node;
use crate::vocabulary::{Arg, ArgKind, Compiled, CompiledPhrase, CompiledTool, check_value, priority};
use std::collections::BTreeMap;

#[derive(Clone, Debug)]
pub struct SettleOptions {
    /// Readings a recognizer is less sure of than this don't settle in stage 1.
    pub min_confidence: Option<f32>,
    /// Run stage 2.
    pub local: bool,
    /// In stage 2, ask back a phrase found inside longer speech – off in LIVE, where speech
    /// around the app isn't all for it.
    pub partial: bool,
}

impl Default for SettleOptions {
    fn default() -> Self {
        SettleOptions { min_confidence: None, local: true, partial: true }
    }
}

const MATCHER: &str = "matcher";

impl Compiled {
    /// Settles what was heard on the device: stage 1, then – where it found nothing and the app
    /// isn't speaking – stage 2.
    pub fn settle(&self, turn: &Turn, heard: &Heard, options: &SettleOptions) -> Settled {
        let language = turn.language;
        let readings: Vec<(Vec<Word>, Option<f32>)> = heard
            .hypotheses
            .iter()
            .map(|hypothesis| (normalize::words(language, &hypothesis.text), hypothesis.confidence))
            .filter(|(words, _)| !words.is_empty())
            .collect();
        let mut trail = Vec::new();
        let step = |stage, outcome, why| Step { stage, by: MATCHER.into(), outcome, why, ms: 0 };
        if readings.is_empty() {
            trail.push(step(Stage::Deterministic, StepOutcome::NoMatch, Some(Why::NothingHeard)));
            return Settled { outcome: None, stage: None, trail };
        }

        let mut why = Why::NoMatch;
        for (words, confidence) in &readings {
            if options.min_confidence.is_some_and(|min| confidence.is_some_and(|confidence| confidence < min)) {
                why = Why::LowConfidence;
                continue;
            }
            if let Some(outcome) = self.stage(turn, words, Strictness::Strict, false) {
                trail.push(step(Stage::Deterministic, StepOutcome::Resolved, None));
                return Settled { outcome: Some(outcome), stage: Some(Stage::Deterministic), trail };
            }
        }
        trail.push(step(Stage::Deterministic, StepOutcome::NoMatch, Some(why)));

        if turn.app_speaking {
            trail.push(step(Stage::Local, StepOutcome::Skipped, Some(Why::InterruptOnly)));
            return Settled { outcome: None, stage: None, trail };
        }
        if !options.local {
            return Settled { outcome: None, stage: None, trail };
        }
        for (words, _) in &readings {
            if let Some(outcome) = self.stage(turn, words, Strictness::Loose, options.partial) {
                trail.push(step(Stage::Local, StepOutcome::Resolved, None));
                return Settled { outcome: Some(outcome), stage: Some(Stage::Local), trail };
            }
        }
        trail.push(step(Stage::Local, StepOutcome::NoMatch, Some(Why::NoMatch)));
        Settled { outcome: None, stage: None, trail }
    }

    fn stage(&self, turn: &Turn, words: &[Word], strictness: Strictness, partial: bool) -> Option<Outcome> {
        let language = turn.language;
        let dropped;
        let words = if strictness == Strictness::Loose {
            dropped = drop_fillers(language, words);
            &dropped[..]
        } else {
            words
        };
        if words.is_empty() {
            return None;
        }
        let norms: Vec<String> = words.iter().map(|word| word.norm.clone()).collect();
        if !turn.app_speaking
            && let Some(pending) = &turn.pending
            && let Some(outcome) = self.answer(turn, pending, words, &norms, strictness)
        {
            return Some(outcome);
        }
        if self.is_builtin(language, Builtin::StopListening, &norms, strictness) {
            return Some(Outcome::StopListening);
        }
        if let Some(outcome) = self.best(turn, words, &norms, strictness) {
            return Some(outcome);
        }
        if partial && strictness == Strictness::Loose {
            return self.within(turn, words, &norms);
        }
        None
    }

    /// The best whole match among the tools offered.
    fn best(&self, turn: &Turn, words: &[Word], norms: &[String], strictness: Strictness) -> Option<Outcome> {
        let mut candidates = self.candidates(turn, words, norms, strictness, Span::Whole);
        candidates.retain(|candidate| acceptable(candidate, strictness, turn.app_speaking));
        let chosen = choose(candidates, strictness)?;
        Some(match chosen {
            Choice::One(candidate) => self.finish(turn, candidate.call),
            Choice::Several(calls) => Outcome::Unsure { candidates: calls },
        })
    }

    /// A phrase inside longer speech: asked back, never acted on.
    fn within(&self, turn: &Turn, words: &[Word], norms: &[String]) -> Option<Outcome> {
        let mut candidates = self.candidates(turn, words, norms, Strictness::Strict, Span::Within);
        candidates.retain(|candidate| acceptable(candidate, Strictness::Strict, false) && candidate.letters >= 4);
        // The phrase that takes the most of what was said.
        let most = candidates.iter().map(|candidate| candidate.covered).max()?;
        candidates.retain(|candidate| candidate.covered == most);
        match choose(candidates, Strictness::Loose)? {
            Choice::One(candidate) => Some(match self.finish(turn, candidate.call) {
                Outcome::Call { calls } => Outcome::Confirm { calls },
                other => other,
            }),
            Choice::Several(calls) => Some(Outcome::Unsure { candidates: calls }),
        }
    }

    fn candidates(
        &self,
        turn: &Turn,
        words: &[Word],
        norms: &[String],
        strictness: Strictness,
        span: Span,
    ) -> Vec<Candidate> {
        let defaults = match &turn.pending {
            Some(Pending::Ask { call, .. }) => Some(call),
            _ => None,
        };
        let mut candidates = Vec::new();
        for tool in &self.tools {
            if turn.app_speaking && !tool.interrupt {
                continue;
            }
            let Some(tool_level) = priority(&tool.contexts, &turn.contexts) else { continue };
            for phrase in tool.phrases.iter().filter(|phrase| phrase.language == turn.language) {
                let level = if phrase.contexts.is_empty() {
                    tool_level
                } else {
                    match priority(&phrase.contexts, &turn.contexts) {
                        Some(level) => level,
                        None => continue,
                    }
                };
                for matched in self.match_phrase(turn.language, tool, phrase, words, norms, strictness, span) {
                    let mut args =
                        defaults.filter(|call| call.tool == tool.id).map(|call| call.args.clone()).unwrap_or_default();
                    args.extend(phrase.args.clone());
                    args.extend(matched.args);
                    candidates.push(Candidate {
                        call: Call { tool: tool.id.clone(), args },
                        level,
                        cost: matched.cost,
                        letters: matched.letters,
                        covered: matched.covered,
                    });
                }
            }
        }
        candidates
    }

    /// A call filled from the app's state where it says nothing else, then asked for what it
    /// still lacks, or for confirmation.
    pub fn finish(&self, turn: &Turn, mut call: Call) -> Outcome {
        let Some(tool) = self.tool(&call.tool) else { return Outcome::Call { calls: vec![call] } };
        // The app's state fills in only where what was said agrees with it: "verse 16" while
        // reading John 3 is John 3:16; "Psalm" is not Psalm 3.
        let agrees = call.args.iter().all(|(name, value)| {
            tool.args.get(name).is_none_or(|arg| arg.kind != ArgKind::Value)
                || turn.state.get(name).is_none_or(|state| state == value)
        });
        if agrees {
            for name in &tool.arg_order {
                let arg = &tool.args[name];
                if arg.required
                    && !call.args.contains_key(name)
                    && let Some(value) = turn.state.get(name)
                    && check_value(arg, value, &self.lists).is_ok()
                {
                    call.args.insert(name.clone(), value.clone());
                }
            }
        }
        if let Some(missing) =
            tool.arg_order.iter().find(|name| tool.args[*name].required && !call.args.contains_key(*name))
        {
            return Outcome::Ask { missing: missing.clone(), call };
        }
        if tool.confirm {
            return Outcome::Confirm { calls: vec![call] };
        }
        Outcome::Call { calls: vec![call] }
    }

    /// An answer to what the app asked: yes or no, a choice, the missing argument.
    fn answer(
        &self,
        turn: &Turn,
        pending: &Pending,
        words: &[Word],
        norms: &[String],
        strictness: Strictness,
    ) -> Option<Outcome> {
        let language = turn.language;
        let yes = self.is_builtin(language, Builtin::Yes, norms, strictness);
        let no = self.is_builtin(language, Builtin::No, norms, strictness)
            || self.is_builtin(language, Builtin::Cancel, norms, strictness);
        match pending {
            Pending::Confirm { calls } => {
                if yes {
                    Some(Outcome::Call { calls: calls.clone() })
                } else if no {
                    Some(Outcome::Cancelled)
                } else {
                    None
                }
            }
            Pending::Choose { candidates } => {
                if no {
                    return Some(Outcome::Cancelled);
                }
                let index = if yes && candidates.len() == 1 {
                    Some(0)
                } else {
                    self.choice_number(language, norms)
                        .and_then(|n| (1..=candidates.len()).contains(&n).then(|| n - 1))
                        .or_else(|| self.choice_by_value(language, candidates, norms, strictness))
                };
                index.map(|index| self.finish(turn, candidates[index].clone()))
            }
            Pending::Ask { call, missing } => {
                if no {
                    return Some(Outcome::Cancelled);
                }
                let tool = self.tool(&call.tool)?;
                let arg = tool.args.get(missing)?;
                let value = self.bare_value(language, arg, words, norms, strictness)?;
                let mut call = call.clone();
                call.args.insert(missing.clone(), value);
                Some(self.finish(turn, call))
            }
        }
    }

    /// The whole utterance as one argument's value: "three", "Psalms", "yes".
    fn bare_value(
        &self,
        language: Language,
        arg: &Arg,
        words: &[Word],
        norms: &[String],
        strictness: Strictness,
    ) -> Option<ArgValue> {
        match arg.kind {
            ArgKind::Number => numbers::parse_at(language, norms, 0)
                .into_iter()
                .filter(|parsed| parsed.len == norms.len() && (strictness == Strictness::Loose || parsed.cost == 0))
                .map(|parsed| ArgValue::Number(parsed.value.into()))
                .find(|value| check_value(arg, value, &self.lists).is_ok()),
            ArgKind::Value => {
                let list = self.lists.get(arg.of.as_ref()?)?;
                let mut ids: Vec<&str> = Vec::new();
                for value in &list.values {
                    for form in value.forms.get(&language).into_iter().flatten() {
                        let cost = form_cost(language, form, norms, strictness);
                        if cost.is_some_and(|cost| {
                            cost == 0 || (cost == 1 && letter_count(form) >= 12) || strictness == Strictness::Loose
                        }) && !ids.contains(&value.id.as_str())
                        {
                            ids.push(&value.id);
                        }
                    }
                }
                match ids.as_slice() {
                    [id] => Some(ArgValue::Text(id.to_string())),
                    _ => None,
                }
            }
            ArgKind::Text => {
                Some(ArgValue::Text(words.iter().map(|word| word.said.as_str()).collect::<Vec<_>>().join(" ")))
            }
            ArgKind::Boolean => {
                if self.is_builtin(language, Builtin::Yes, norms, strictness) {
                    Some(ArgValue::Flag(true))
                } else if self.is_builtin(language, Builtin::No, norms, strictness) {
                    Some(ArgValue::Flag(false))
                } else {
                    None
                }
            }
        }
    }

    /// "the second", "zwei", "ikinci": a choice by its number.
    fn choice_number(&self, language: Language, norms: &[String]) -> Option<usize> {
        let whole = |norms: &[String]| {
            numbers::parse_at(language, norms, 0)
                .into_iter()
                .find(|parsed| parsed.len == norms.len() && parsed.cost == 0)
                .map(|parsed| parsed.value as usize)
        };
        whole(norms).or_else(|| {
            let around: Vec<String> =
                builtin::choice_words(language).iter().map(|word| normalize::fold(language, word)).collect();
            let rest: Vec<String> = norms.iter().filter(|norm| !around.contains(norm)).cloned().collect();
            if rest.is_empty() || rest.len() == norms.len() { None } else { whole(&rest) }
        })
    }

    /// "Jonah", when the choice was John or Jonah: the one candidate a named value is in.
    fn choice_by_value(
        &self,
        language: Language,
        candidates: &[Call],
        norms: &[String],
        strictness: Strictness,
    ) -> Option<usize> {
        let mut ids = Vec::new();
        for list in self.lists.values() {
            for value in &list.values {
                for form in value.forms.get(&language).into_iter().flatten() {
                    if form_cost(language, form, norms, strictness) == Some(0) {
                        ids.push(value.id.as_str());
                    }
                }
            }
        }
        let holding: Vec<usize> = candidates
            .iter()
            .enumerate()
            .filter(|(_, call)| {
                call.args.values().any(|value| matches!(value, ArgValue::Text(id) if ids.contains(&id.as_str())))
            })
            .map(|(index, _)| index)
            .collect();
        match holding.as_slice() {
            [index] => Some(*index),
            _ => None,
        }
    }

    fn is_builtin(&self, language: Language, builtin: Builtin, norms: &[String], strictness: Strictness) -> bool {
        let Some(phrases) = self.builtins.get(&(language, builtin)) else { return false };
        phrases.iter().any(|phrase| {
            form_cost(language, phrase, norms, strictness).is_some_and(|cost| {
                cost == 0
                    || (cost == 1 && letter_count(phrase) >= 12)
                    || (strictness == Strictness::Loose && cost * 4 <= letter_count(phrase))
            })
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn match_phrase(
        &self,
        language: Language,
        tool: &CompiledTool,
        phrase: &CompiledPhrase,
        words: &[Word],
        norms: &[String],
        strictness: Strictness,
        span: Span,
    ) -> Vec<Matched> {
        let budget = match strictness {
            Strictness::Strict => 1,
            Strictness::Loose => 4,
        };
        let mut walk = Walk {
            compiled: self,
            language,
            tool,
            words,
            norms,
            strictness,
            budget,
            whole: span == Span::Whole,
            found: Vec::new(),
        };
        let starts = match span {
            Span::Whole => 0..1,
            Span::Within => 0..words.len(),
        };
        for start in starts {
            let mut continuations = vec![phrase.nodes.as_slice()];
            let mut args = Vec::new();
            walk.walk(&mut continuations, start, start, 0, 0, &mut args);
        }
        let mut matched: Vec<Matched> = walk.found;
        if span == Span::Within {
            // Inside longer speech only: the phrase must leave words around it.
            matched.retain(|m| m.covered < words.len());
        }
        matched
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Strictness {
    Strict,
    Loose,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Span {
    Whole,
    Within,
}

#[derive(Debug)]
struct Matched {
    args: BTreeMap<String, ArgValue>,
    cost: u32,
    letters: u32,
    covered: usize,
}

#[derive(Debug)]
struct Candidate {
    call: Call,
    level: usize,
    cost: u32,
    letters: u32,
    covered: usize,
}

enum Choice {
    One(Candidate),
    Several(Vec<Call>),
}

fn acceptable(candidate: &Candidate, strictness: Strictness, app_speaking: bool) -> bool {
    if app_speaking {
        return candidate.cost == 0;
    }
    match strictness {
        Strictness::Strict => candidate.cost == 0 || (candidate.cost == 1 && candidate.letters >= 12),
        Strictness::Loose => candidate.cost <= (candidate.letters / 4).max(1),
    }
}

/// The best call: in the context in front, the closest, the one that says the most. Several when
/// they tie – or, matching loosely, when another is nearly as close.
fn choose(mut candidates: Vec<Candidate>, strictness: Strictness) -> Option<Choice> {
    candidates.sort_by(|a, b| a.level.cmp(&b.level).then(a.cost.cmp(&b.cost)).then(b.letters.cmp(&a.letters)));
    let best = candidates.first()?;
    let (level, cost, letters) = (best.level, best.cost, best.letters);
    let mut calls: Vec<Call> = Vec::new();
    for candidate in &candidates {
        let ties = candidate.level == level
            && ((candidate.cost == cost && candidate.letters == letters)
                || (strictness == Strictness::Loose && candidate.cost <= cost + 1 && candidate.letters >= letters));
        if ties && !calls.contains(&candidate.call) {
            calls.push(candidate.call.clone());
        }
    }
    if calls.len() > 1 {
        calls.truncate(3);
        return Some(Choice::Several(calls));
    }
    Some(Choice::One(candidates.swap_remove(0)))
}

fn drop_fillers(language: Language, words: &[Word]) -> Vec<Word> {
    let fillers: Vec<Vec<String>> =
        builtin::fillers(language).iter().map(|filler| normalize::normalize(language, filler)).collect();
    let mut kept = Vec::new();
    let mut at = 0;
    'words: while at < words.len() {
        for filler in &fillers {
            let end = at + filler.len();
            if end <= words.len() && words[at..end].iter().zip(filler).all(|(word, filler)| &word.norm == filler) {
                at = end;
                continue 'words;
            }
        }
        kept.push(words[at].clone());
        at += 1;
    }
    kept
}

/// Walks a phrase's nodes over the words heard, collecting every way they fit.
struct Walk<'a> {
    compiled: &'a Compiled,
    language: Language,
    tool: &'a CompiledTool,
    words: &'a [Word],
    norms: &'a [String],
    strictness: Strictness,
    budget: u32,
    whole: bool,
    found: Vec<Matched>,
}

impl<'a> Walk<'a> {
    fn walk(
        &mut self,
        continuations: &mut Vec<&'a [Node]>,
        start: usize,
        at: usize,
        cost: u32,
        letters: u32,
        args: &mut Vec<(String, ArgValue)>,
    ) {
        if self.found.len() >= 64 || cost > self.budget {
            return;
        }
        let Some(top) = continuations.pop() else {
            if (!self.whole || at == self.words.len()) && at > start {
                let args = args.iter().cloned().collect();
                self.found.push(Matched { args, cost, letters, covered: at - start });
            }
            return;
        };
        let Some((node, rest)) = top.split_first() else {
            self.walk(continuations, start, at, cost, letters, args);
            continuations.push(top);
            return;
        };
        continuations.push(rest);
        match node {
            Node::Word(word) => {
                let left = self.budget - cost;
                let word_letters = letters_of(word);
                if let Some(heard) = self.norms.get(at)
                    && let Some(c) = word_cost(self.language, word, heard, self.strictness, left)
                {
                    self.walk(continuations, start, at + 1, cost + c, letters + word_letters, args);
                }
                // Heard as two words: "zu hören".
                if at + 1 < self.norms.len() {
                    let joined = format!("{}{}", self.norms[at], self.norms[at + 1]);
                    if let Some(c) = word_cost(self.language, word, &joined, self.strictness, left) {
                        self.walk(continuations, start, at + 2, cost + c, letters + word_letters, args);
                    }
                }
                // Two words of the phrase heard as one: "wobin".
                if let Some(Node::Word(next)) = rest.first()
                    && let Some(heard) = self.norms.get(at)
                {
                    let joined = format!("{word}{next}");
                    if let Some(c) = word_cost(self.language, &joined, heard, self.strictness, left) {
                        continuations.pop();
                        continuations.push(&rest[1..]);
                        self.walk(continuations, start, at + 1, cost + c, letters + letters_of(&joined), args);
                        continuations.pop();
                        continuations.push(rest);
                    }
                }
            }
            Node::Slot(name) => {
                if let Some(arg) = self.tool.args.get(name) {
                    self.slot(continuations, start, at, cost, letters, args, name, arg);
                }
            }
            Node::Optional(inner) => {
                continuations.push(inner);
                self.walk(continuations, start, at, cost, letters, args);
                continuations.pop();
                self.walk(continuations, start, at, cost, letters, args);
            }
            Node::Choice(alternatives) => {
                for alternative in alternatives {
                    continuations.push(alternative);
                    self.walk(continuations, start, at, cost, letters, args);
                    continuations.pop();
                }
            }
        }
        continuations.pop();
        continuations.push(top);
    }

    #[allow(clippy::too_many_arguments)]
    fn slot(
        &mut self,
        continuations: &mut Vec<&'a [Node]>,
        start: usize,
        at: usize,
        cost: u32,
        letters: u32,
        args: &mut Vec<(String, ArgValue)>,
        name: &str,
        arg: &Arg,
    ) {
        match arg.kind {
            ArgKind::Number => {
                for parsed in numbers::parse_at(self.language, self.norms, at) {
                    let value = ArgValue::Number(parsed.value.into());
                    if parsed.cost > 0 && self.strictness == Strictness::Strict {
                        continue;
                    }
                    if check_value(arg, &value, &self.compiled.lists).is_err() {
                        continue;
                    }
                    args.push((name.to_string(), value));
                    self.walk(continuations, start, at + parsed.len, cost + parsed.cost, letters, args);
                    args.pop();
                }
            }
            ArgKind::Value => {
                let Some(list) = arg.of.as_ref().and_then(|list| self.compiled.lists.get(list)) else { return };
                let left = self.budget - cost;
                for value in &list.values {
                    for form in value.forms.get(&self.language).into_iter().flatten() {
                        let form_letters = letter_count(form);
                        let joined = form.concat();
                        let lowest = form.len().saturating_sub(1).max(1);
                        for end in (at + lowest)..=(at + form.len() + 1).min(self.norms.len()) {
                            let heard = self.norms[at..end].concat();
                            if let Some(c) = word_cost(self.language, &joined, &heard, self.strictness, left) {
                                args.push((name.to_string(), ArgValue::Text(value.id.clone())));
                                self.walk(continuations, start, end, cost + c, letters + form_letters, args);
                                args.pop();
                            }
                        }
                    }
                }
            }
            ArgKind::Text => {
                for end in (at + 1)..=self.words.len() {
                    let text = self.words[at..end].iter().map(|word| word.said.as_str()).collect::<Vec<_>>().join(" ");
                    args.push((name.to_string(), ArgValue::Text(text)));
                    self.walk(continuations, start, end, cost, letters, args);
                    args.pop();
                }
            }
            ArgKind::Boolean => {}
        }
    }
}

/// How far a word heard is from the word wanted, within `left` edits – or not close enough.
fn word_cost(language: Language, wanted: &str, heard: &str, strictness: Strictness, left: u32) -> Option<u32> {
    if wanted == heard {
        return Some(0);
    }
    if strictness == Strictness::Loose {
        // "وال" before a name, "ب" before a word: Arabic writes them on.
        let proclitics: &[&str] = match language {
            Language::Ar => &["وال", "بال", "فال", "لل", "ال", "و", "ف", "ب", "ل"],
            Language::Fa => &["و"],
            _ => &[],
        };
        for proclitic in proclitics {
            if let Some(stripped) = heard.strip_prefix(proclitic)
                && stripped == wanted
            {
                return Some(0);
            }
        }
        // Turkish suffixes: "Yuhanna'yı" written without its apostrophe, "bölüme".
        if language == Language::Tr
            && let Some(suffix) = heard.strip_prefix(wanted)
            && suffix.chars().count() <= 4
            && wanted.chars().count() >= 3
        {
            return Some(0);
        }
    }
    let wanted_letters = letters_of(wanted);
    let allowed = match strictness {
        Strictness::Strict => left.min(1),
        Strictness::Loose => left.min((wanted_letters / 3).max(1)),
    };
    edit_distance(wanted, heard, allowed)
}

/// How far the words heard are from a phrase's words, as one.
fn form_cost(language: Language, form: &[String], norms: &[String], strictness: Strictness) -> Option<u32> {
    let budget = match strictness {
        Strictness::Strict => 1,
        Strictness::Loose => (letter_count(form) / 4).max(1),
    };
    word_cost(language, &form.concat(), &norms.concat(), strictness, budget)
}

fn letter_count(words: &[String]) -> u32 {
    words.iter().map(|word| letters_of(word)).sum()
}

fn letters_of(word: &str) -> u32 {
    word.chars().count() as u32
}

/// Levenshtein distance between `a` and `b`, if it is at most `max`.
pub(crate) fn edit_distance(a: &str, b: &str, max: u32) -> Option<u32> {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.len().abs_diff(b.len()) as u32 > max {
        return None;
    }
    let mut previous: Vec<u32> = (0..=b.len() as u32).collect();
    let mut current = vec![0; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        current[0] = i as u32 + 1;
        let mut lowest = current[0];
        for (j, cb) in b.iter().enumerate() {
            let substitution = previous[j] + u32::from(ca != cb);
            current[j + 1] = substitution.min(previous[j + 1] + 1).min(current[j] + 1);
            lowest = lowest.min(current[j + 1]);
        }
        if lowest > max {
            return None;
        }
        std::mem::swap(&mut previous, &mut current);
    }
    let distance = previous[b.len()];
    (distance <= max).then_some(distance)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::Hypothesis;
    use crate::vocabulary::tests_support::reader;
    use Language::*;

    fn heard(texts: &[&str]) -> Heard {
        Heard {
            recognizer: "test".into(),
            hypotheses: texts.iter().map(|text| Hypothesis { text: text.to_string(), confidence: None }).collect(),
            speech_ms: 1000,
        }
    }

    fn turn(language: Language, contexts: &[&str]) -> Turn {
        Turn {
            language,
            contexts: contexts.iter().map(|context| context.to_string()).collect(),
            state: BTreeMap::new(),
            pending: None,
            app_speaking: false,
        }
    }

    fn call(tool: &str, args: &[(&str, ArgValue)]) -> Call {
        Call { tool: tool.into(), args: args.iter().map(|(name, value)| (name.to_string(), value.clone())).collect() }
    }

    fn n(value: i64) -> ArgValue {
        ArgValue::Number(value)
    }

    fn id(value: &str) -> ArgValue {
        ArgValue::Text(value.into())
    }

    fn settle(turn: &Turn, texts: &[&str]) -> Settled {
        let compiled = reader().compile().unwrap();
        compiled.settle(turn, &heard(texts), &SettleOptions::default())
    }

    fn calls(settled: &Settled) -> Vec<Call> {
        match &settled.outcome {
            Some(Outcome::Call { calls }) => calls.clone(),
            other => panic!("not a call: {other:?} ({:?})", settled.trail),
        }
    }

    #[test]
    fn references_in_words_and_digits() {
        let reading = turn(De, &["reading"]);
        let open =
            |book, chapter, verse| call("open", &[("book", id(book)), ("chapter", n(chapter)), ("verse", n(verse))]);
        assert_eq!(calls(&settle(&reading, &["Lies Psalm 139,14"])), [open("PSA", 139, 14)]);
        assert_eq!(
            calls(&settle(&reading, &["lies psalm hundertneununddreißig vers vierzehn"])),
            [open("PSA", 139, 14)]
        );
        assert_eq!(calls(&settle(&turn(En, &[]), &["John three sixteen"])), [open("JHN", 3, 16)]);
        assert_eq!(calls(&settle(&turn(En, &[]), &["read first John 4 7"])), [open("1JN", 4, 7)]);
        assert_eq!(settle(&reading, &["Lies Psalm 139,14"]).stage, Some(Stage::Deterministic));
    }

    #[test]
    fn the_context_in_front_wins() {
        let next = calls(&settle(&turn(En, &["reading"]), &["next"]));
        assert_eq!(next, [call("move", &[("step", id("verse+1"))])]);
        let next = calls(&settle(&turn(En, &["library", "reading"]), &["next"]));
        assert_eq!(next, [call("select", &[])]);
        // Not offered without its context.
        assert!(settle(&turn(En, &[]), &["next verse"]).outcome.is_none());
    }

    #[test]
    fn the_app_state_fills_what_goes_unsaid() {
        let mut reading = turn(En, &["reading"]);
        reading.state.insert("book".into(), id("JHN"));
        reading.state.insert("chapter".into(), n(3));
        assert_eq!(
            calls(&settle(&reading, &["verse 16"])),
            [call("open", &[("book", id("JHN")), ("chapter", n(3)), ("verse", n(16))])]
        );
        // A book said that isn't the state's takes nothing from it.
        let settled = settle(&reading, &["Psalm"]);
        assert!(
            matches!(settled.outcome, Some(Outcome::Ask { ref missing, .. }) if missing == "chapter"),
            "{settled:?}"
        );
    }

    #[test]
    fn asking_and_answering() {
        let mut asking = turn(De, &[]);
        asking.pending = Some(Pending::Ask { call: call("open", &[("book", id("PSA"))]), missing: "chapter".into() });
        assert_eq!(
            calls(&settle(&asking, &["dreiundzwanzig"])),
            [call("open", &[("book", id("PSA")), ("chapter", n(23))])]
        );
        assert_eq!(settle(&asking, &["abbrechen"]).outcome, Some(Outcome::Cancelled));
        // A whole new command is taken as it is.
        assert_eq!(calls(&settle(&asking, &["wo bin ich"])), [call("whereAmI", &[])]);
    }

    #[test]
    fn consequential_tools_confirm() {
        let settled = settle(&turn(En, &[]), &["delete all bookmarks"]);
        let delete = call("deleteBookmarks", &[]);
        assert_eq!(settled.outcome, Some(Outcome::Confirm { calls: vec![delete.clone()] }));
        let mut confirming = turn(En, &[]);
        confirming.pending = Some(Pending::Confirm { calls: vec![delete.clone()] });
        assert_eq!(calls(&settle(&confirming, &["yes"])), [delete]);
        assert_eq!(settle(&confirming, &["no"]).outcome, Some(Outcome::Cancelled));
    }

    #[test]
    fn choosing_by_number_or_name() {
        let mut choosing = turn(En, &[]);
        let john = call("open", &[("book", id("JHN")), ("chapter", n(1))]);
        let jonah = call("open", &[("book", id("JON")), ("chapter", n(1))]);
        choosing.pending = Some(Pending::Choose { candidates: vec![john.clone(), jonah.clone()] });
        assert_eq!(calls(&settle(&choosing, &["the second one"])), std::slice::from_ref(&jonah));
        assert_eq!(calls(&settle(&choosing, &["two"])), std::slice::from_ref(&jonah));
        assert_eq!(calls(&settle(&choosing, &["John"])), [john]);
    }

    #[test]
    fn misheard_words() {
        let reading = turn(De, &["reading"]);
        // One edit in a long phrase is still stage 1; in a short one, stage 2.
        let settled = settle(&reading, &["lies johannesevangelim 3"]);
        assert_eq!(settled.stage, Some(Stage::Deterministic), "{settled:?}");
        let settled = settle(&reading, &["nächste vers"]);
        assert_eq!(
            (settled.stage, calls(&settled)),
            (Some(Stage::Deterministic), vec![call("move", &[("step", id("verse+1"))])])
        );
        let settled = settle(&reading, &["stop"]);
        assert_eq!((settled.stage, calls(&settled)), (Some(Stage::Local), vec![call("stop", &[])]));
        // Fillers go in stage 2.
        let settled = settle(&turn(En, &[]), &["uh where am I please"]);
        assert_eq!((settled.stage, calls(&settled)), (Some(Stage::Local), vec![call("whereAmI", &[])]));
    }

    #[test]
    fn inside_longer_speech_only_asks() {
        let settled = settle(&turn(En, &[]), &["I want to read John 3 now"]);
        assert_eq!(
            settled.outcome,
            Some(Outcome::Confirm { calls: vec![call("open", &[("book", id("JHN")), ("chapter", n(3))])] })
        );
        let compiled = reader().compile().unwrap();
        let live = SettleOptions { partial: false, ..SettleOptions::default() };
        assert_eq!(compiled.settle(&turn(En, &[]), &heard(&["I want to read John 3 now"]), &live).outcome, None);
        // Unrelated speech settles nothing.
        assert_eq!(settle(&turn(En, &["reading"]), &["the weather is nice today"]).outcome, None);
    }

    #[test]
    fn while_the_app_speaks_only_interrupts() {
        let mut speaking = turn(En, &["reading"]);
        speaking.app_speaking = true;
        assert_eq!(calls(&settle(&speaking, &["stop"])), [call("stop", &[])]);
        assert_eq!(calls(&settle(&speaking, &["next verse"])), [call("move", &[("step", id("verse+1"))])]);
        let settled = settle(&speaking, &["read John 3"]);
        assert_eq!(settled.outcome, None);
        assert_eq!(settled.trail.last().and_then(|step| step.why), Some(Why::InterruptOnly));
        assert_eq!(settle(&speaking, &["stopp"]).outcome, None, "no edits while the app speaks");
    }

    #[test]
    fn stop_listening_and_text() {
        assert_eq!(settle(&turn(De, &[]), &["Hör auf zuzuhören"]).outcome, Some(Outcome::StopListening));
        assert_eq!(
            calls(&settle(&turn(De, &[]), &["Suche nach dem verlorenen Schaf"])),
            [call("search", &[("query", ArgValue::Text("dem verlorenen Schaf".into()))])]
        );
    }

    #[test]
    fn n_best_and_confidence() {
        let compiled = reader().compile().unwrap();
        let mut texts = heard(&["the weather", "where am I"]);
        assert_eq!(calls(&compiled.settle(&turn(En, &[]), &texts, &SettleOptions::default())), [call("whereAmI", &[])]);
        texts.hypotheses[1].confidence = Some(0.2);
        let sure = SettleOptions { min_confidence: Some(0.5), local: false, partial: false };
        let settled = compiled.settle(&turn(En, &[]), &texts, &sure);
        assert_eq!(settled.outcome, None);
        assert_eq!(settled.trail[0].why, Some(Why::LowConfidence));
    }

    #[test]
    fn edit_distances() {
        assert_eq!(edit_distance("kitten", "sitting", 3), Some(3));
        assert_eq!(edit_distance("kitten", "sitting", 2), None);
        assert_eq!(edit_distance("يونس", "يوحنا", 1), None);
        assert_eq!(edit_distance("", "ab", 2), Some(2));
    }
}
