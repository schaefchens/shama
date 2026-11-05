//! Words Shama understands in every app: answers to its questions, the end of a LIVE
//! conversation, and the fillers it drops when it matches more loosely. An app adds its own.

use crate::Language;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Builtin {
    Yes,
    No,
    Cancel,
    StopListening,
}

impl Builtin {
    pub const ALL: [Builtin; 4] = [Builtin::Yes, Builtin::No, Builtin::Cancel, Builtin::StopListening];

    /// The name an app's vocabulary uses for it.
    pub fn name(self) -> &'static str {
        match self {
            Builtin::Yes => "yes",
            Builtin::No => "no",
            Builtin::Cancel => "cancel",
            Builtin::StopListening => "stopListening",
        }
    }

    pub fn from_name(name: &str) -> Option<Builtin> {
        Builtin::ALL.into_iter().find(|builtin| builtin.name() == name)
    }

    pub fn phrases(self, language: Language) -> &'static [&'static str] {
        use Language::*;
        match (self, language) {
            (Builtin::Yes, En) => {
                &["yes", "yeah", "yep", "yup", "sure", "correct", "right", "okay", "ok", "go ahead", "do it"]
            }
            (Builtin::Yes, De) => &["ja", "jawohl", "genau", "richtig", "okay", "ok", "mach das", "gerne"],
            (Builtin::Yes, Tr) => &["evet", "tamam", "olur", "doğru", "peki"],
            (Builtin::Yes, Ar) => &["نعم", "أجل", "صحيح", "حسنا", "موافق", "تمام"],
            (Builtin::Yes, Fa) => &["بله", "آره", "بلی", "درسته", "باشه", "حتما"],
            (Builtin::No, En) => &["no", "nope", "nah", "don't"],
            (Builtin::No, De) => &["nein", "nee", "lieber nicht"],
            (Builtin::No, Tr) => &["hayır", "yok", "istemiyorum"],
            (Builtin::No, Ar) => &["لا", "كلا"],
            (Builtin::No, Fa) => &["نه", "خیر", "نخیر"],
            (Builtin::Cancel, En) => &["cancel", "never mind", "forget it"],
            (Builtin::Cancel, De) => &["abbrechen", "vergiss es", "egal"],
            (Builtin::Cancel, Tr) => &["iptal", "iptal et", "vazgeç", "boş ver"],
            (Builtin::Cancel, Ar) => &["إلغاء", "ألغ", "انس الأمر"],
            (Builtin::Cancel, Fa) => &["لغو", "لغو کن", "بیخیال", "ولش کن"],
            (Builtin::StopListening, En) => &["stop listening", "end the conversation", "that's all", "goodbye"],
            (Builtin::StopListening, De) => {
                &["hör auf zuzuhören", "nicht mehr zuhören", "gespräch beenden", "das ist alles", "tschüss"]
            }
            (Builtin::StopListening, Tr) => {
                &["dinlemeyi bırak", "dinlemeyi durdur", "konuşmayı bitir", "hepsi bu", "hoşça kal"]
            }
            (Builtin::StopListening, Ar) => &["توقف عن الاستماع", "أنه المحادثة", "هذا كل شيء", "مع السلامة"],
            (Builtin::StopListening, Fa) => &["دیگر گوش نده", "مکالمه را تمام کن", "همین بود", "خداحافظ"],
        }
    }
}

/// Words dropped when matching loosely: "please", "uh".
pub fn fillers(language: Language) -> &'static [&'static str] {
    match language {
        Language::En => {
            &["please", "uh", "um", "umm", "hmm", "er", "so", "well", "hey", "just", "could you", "can you"]
        }
        Language::De => &["bitte", "äh", "ähm", "hm", "also", "mal", "doch", "hey", "kannst du", "könntest du"],
        Language::Tr => &["lütfen", "ııı", "şey", "hani", "yani"],
        Language::Ar => &["من فضلك", "لو سمحت", "رجاء", "ممكن", "يعني"],
        Language::Fa => &["لطفا", "لطفاً", "خب", "یعنی", "میشه"],
    }
}

/// Words around a choice by its number: "the second", "Nummer zwei".
pub fn choice_words(language: Language) -> &'static [&'static str] {
    match language {
        Language::En => &["the", "number", "one"],
        Language::De => &["die", "der", "das", "den", "nummer"],
        Language::Tr => &["numara", "numaralı"],
        Language::Ar => &["رقم"],
        Language::Fa => &["شماره", "گزینه"],
    }
}
