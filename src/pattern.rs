//! The phrases an app writes for its tools: words, `[optional]` parts, `(one|or other)` choices
//! and `{argument}` slots – "[lies] {book} [kapitel] {chapter} [vers] {verse}".

use crate::Language;
use crate::normalize::normalize;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Node {
    /// A normalized word.
    Word(String),
    Slot(String),
    Optional(Vec<Node>),
    Choice(Vec<Vec<Node>>),
}

/// A pattern's nodes, its words normalized for `language`.
pub fn parse(language: Language, pattern: &str) -> Result<Vec<Node>, String> {
    parse_with(Some(language), pattern)
}

/// A pattern's nodes with its words as written: for recognizers, which want them spelled right.
pub fn parse_as_written(pattern: &str) -> Result<Vec<Node>, String> {
    parse_with(None, pattern)
}

fn parse_with(language: Option<Language>, pattern: &str) -> Result<Vec<Node>, String> {
    let tokens = lex(pattern)?;
    let mut at = 0;
    let nodes = sequence(language, &tokens, &mut at, None)?;
    if at < tokens.len() {
        return Err(format!("unexpected '{}'", tokens[at].text()));
    }
    if nodes.is_empty() {
        return Err("the phrase is empty".into());
    }
    if !says_something(&nodes) {
        return Err("every part of the phrase is optional".into());
    }
    Ok(nodes)
}

/// The slots of a pattern, in order, each once.
pub fn slots(nodes: &[Node]) -> Vec<String> {
    let mut names = Vec::new();
    collect_slots(nodes, &mut names);
    names
}

/// A word or a slot, in one way of saying a pattern.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Piece {
    Word(String),
    Slot(String),
}

/// The ways of saying a pattern, at most `limit` of them.
pub fn expand(nodes: &[Node], limit: usize) -> Vec<Vec<Piece>> {
    let mut ways = vec![Vec::new()];
    for node in nodes {
        let mut next = Vec::new();
        let tails: Vec<Vec<Piece>> = match node {
            Node::Word(word) => vec![vec![Piece::Word(word.clone())]],
            Node::Slot(name) => vec![vec![Piece::Slot(name.clone())]],
            Node::Optional(inner) => {
                let mut tails = expand(inner, limit);
                tails.push(Vec::new());
                tails
            }
            Node::Choice(alternatives) => {
                alternatives.iter().flat_map(|alternative| expand(alternative, limit)).collect()
            }
        };
        'ways: for way in &ways {
            for tail in &tails {
                if next.len() >= limit {
                    break 'ways;
                }
                let mut longer = way.clone();
                longer.extend(tail.iter().cloned());
                next.push(longer);
            }
        }
        ways = next;
    }
    ways
}

#[derive(Debug, PartialEq)]
enum Token {
    Open(char),
    Close(char),
    Bar,
    Slot(String),
    Word(String),
}

impl Token {
    fn text(&self) -> String {
        match self {
            Token::Open(c) | Token::Close(c) => c.to_string(),
            Token::Bar => "|".into(),
            Token::Slot(name) => format!("{{{name}}}"),
            Token::Word(word) => word.clone(),
        }
    }
}

fn lex(pattern: &str) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    let mut word = String::new();
    let mut chars = pattern.chars().peekable();
    let flush = |word: &mut String, tokens: &mut Vec<Token>| {
        if !word.is_empty() {
            tokens.push(Token::Word(std::mem::take(word)));
        }
    };
    while let Some(c) = chars.next() {
        match c {
            '[' | '(' => {
                flush(&mut word, &mut tokens);
                tokens.push(Token::Open(c));
            }
            ']' | ')' => {
                flush(&mut word, &mut tokens);
                tokens.push(Token::Close(c));
            }
            '|' => {
                flush(&mut word, &mut tokens);
                tokens.push(Token::Bar);
            }
            '{' => {
                flush(&mut word, &mut tokens);
                let mut name = String::new();
                loop {
                    match chars.next() {
                        Some('}') => break,
                        Some(c) => name.push(c),
                        None => return Err("a slot isn't closed with '}'".into()),
                    }
                }
                let name = name.trim().to_string();
                if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    return Err(format!("'{{{name}}}' isn't a slot name: letters, digits and _ only"));
                }
                tokens.push(Token::Slot(name));
            }
            '}' => return Err("'}' without its '{'".into()),
            c if c.is_whitespace() => flush(&mut word, &mut tokens),
            c => word.push(c),
        }
    }
    flush(&mut word, &mut tokens);
    Ok(tokens)
}

/// Nodes up to the closing bracket `until`, or to the end; a choice when `|` separates them.
fn sequence(
    language: Option<Language>,
    tokens: &[Token],
    at: &mut usize,
    until: Option<char>,
) -> Result<Vec<Node>, String> {
    let mut alternatives = vec![Vec::new()];
    while let Some(token) = tokens.get(*at) {
        *at += 1;
        let current = alternatives.last_mut().expect("one at least");
        match token {
            Token::Word(word) => match language {
                Some(language) => current.extend(normalize(language, word).into_iter().map(Node::Word)),
                None => current.push(Node::Word(word.clone())),
            },
            Token::Slot(name) => current.push(Node::Slot(name.clone())),
            Token::Open('[') => {
                let inner = sequence(language, tokens, at, Some(']'))?;
                if inner.is_empty() {
                    return Err("'[]' is empty".into());
                }
                current.push(Node::Optional(inner));
            }
            Token::Open(_) => {
                let inner = sequence(language, tokens, at, Some(')'))?;
                if inner.is_empty() {
                    return Err("'()' is empty".into());
                }
                // A choice of one is its sequence.
                match inner.as_slice() {
                    [Node::Choice(_)] => current.extend(inner),
                    _ => current.push(Node::Choice(vec![inner])),
                }
            }
            Token::Bar => {
                if until.is_none() {
                    return Err("'|' outside brackets: '(a|b)', or '[a|b]' where it may be left out".into());
                }
                alternatives.push(Vec::new());
            }
            Token::Close(close) => {
                if until != Some(*close) {
                    return Err(format!("'{close}' without its opening bracket"));
                }
                return finish(alternatives);
            }
        }
    }
    match until {
        Some(close) => Err(format!("'{}' isn't closed with '{close}'", if close == ']' { '[' } else { '(' })),
        None => finish(alternatives),
    }
}

fn finish(alternatives: Vec<Vec<Node>>) -> Result<Vec<Node>, String> {
    if alternatives.len() == 1 {
        return Ok(alternatives.into_iter().next().unwrap_or_default());
    }
    if alternatives.iter().any(Vec::is_empty) {
        return Err("an empty choice in '( | )'".into());
    }
    Ok(vec![Node::Choice(alternatives)])
}

fn says_something(nodes: &[Node]) -> bool {
    nodes.iter().any(|node| match node {
        Node::Word(_) | Node::Slot(_) => true,
        Node::Optional(_) => false,
        Node::Choice(alternatives) => alternatives.iter().all(|alternative| says_something(alternative)),
    })
}

fn collect_slots(nodes: &[Node], names: &mut Vec<String>) {
    for node in nodes {
        match node {
            Node::Word(_) => {}
            Node::Slot(name) => {
                if !names.contains(name) {
                    names.push(name.clone());
                }
            }
            Node::Optional(inner) => collect_slots(inner, names),
            Node::Choice(alternatives) => alternatives.iter().for_each(|alternative| collect_slots(alternative, names)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Node::*;

    fn w(word: &str) -> Node {
        Word(word.into())
    }

    #[test]
    fn words_optionals_choices_and_slots() {
        let nodes = parse(Language::De, "[Lies] {book} [Kapitel] {chapter} (Vers|V) {verse}").unwrap();
        assert_eq!(
            nodes,
            vec![
                Optional(vec![w("lies")]),
                Slot("book".into()),
                Optional(vec![w("kapitel")]),
                Slot("chapter".into()),
                Choice(vec![vec![w("vers")], vec![w("v")]]),
                Slot("verse".into()),
            ]
        );
        assert_eq!(slots(&nodes), ["book", "chapter", "verse"]);
    }

    #[test]
    fn nested_and_multi_word_choices() {
        let nodes = parse(Language::En, "(stop listening|that's all [for now])").unwrap();
        assert_eq!(
            nodes,
            vec![Choice(vec![
                vec![w("stop"), w("listening")],
                vec![w("thats"), w("all"), Optional(vec![w("for"), w("now")])],
            ])]
        );
        let ways = expand(&nodes, 10);
        assert_eq!(ways.len(), 3);
        assert!(ways.contains(&vec![Piece::Word("thats".into()), Piece::Word("all".into())]));
    }

    #[test]
    fn a_choice_left_out() {
        let nodes = parse(Language::En, "[read|open] {book}").unwrap();
        assert_eq!(nodes, vec![Optional(vec![Choice(vec![vec![w("read")], vec![w("open")]])]), Slot("book".into())]);
    }

    #[test]
    fn errors() {
        assert!(parse(Language::En, "[next").is_err());
        assert!(parse(Language::En, "next]").is_err());
        assert!(parse(Language::En, "{book").is_err());
        assert!(parse(Language::En, "{bo ok}").is_err());
        assert!(parse(Language::En, "a | b").is_err());
        assert!(parse(Language::En, "(a|)").is_err());
        assert!(parse(Language::En, "[please]").is_err());
        assert!(parse(Language::En, "   ").is_err());
    }

    #[test]
    fn arabic_words_normalize() {
        let nodes = parse(Language::Ar, "[اِقْرَأْ] سُورَة {surah}").unwrap();
        assert_eq!(nodes, vec![Optional(vec![w("اقرا")]), w("سوره"), Slot("surah".into())]);
    }
}
