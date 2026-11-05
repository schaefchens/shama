use serde::{Deserialize, Serialize};
use std::fmt;

/// The languages Shama has normalization rules, number words and built-in words for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    En,
    De,
    Tr,
    Ar,
    Fa,
}

impl Language {
    pub const ALL: [Language; 5] = [Language::En, Language::De, Language::Tr, Language::Ar, Language::Fa];

    /// The BCP 47 code, as apps and recognizers name it.
    pub fn code(self) -> &'static str {
        match self {
            Language::En => "en",
            Language::De => "de",
            Language::Tr => "tr",
            Language::Ar => "ar",
            Language::Fa => "fa",
        }
    }

    /// Takes a BCP 47 tag – "de", "de-DE", "fa_IR" – by its language subtag.
    pub fn from_code(code: &str) -> Option<Language> {
        let primary = code.split(['-', '_']).next()?.to_ascii_lowercase();
        Language::ALL.into_iter().find(|language| language.code() == primary)
    }

    pub fn right_to_left(self) -> bool {
        matches!(self, Language::Ar | Language::Fa)
    }
}

impl fmt::Display for Language {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_with_regions() {
        assert_eq!(Language::from_code("de-DE"), Some(Language::De));
        assert_eq!(Language::from_code("fa_IR"), Some(Language::Fa));
        assert_eq!(Language::from_code("AR"), Some(Language::Ar));
        assert_eq!(Language::from_code("fr"), None);
    }
}
