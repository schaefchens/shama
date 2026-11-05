//! Words as Shama compares them: what a recognizer heard and what an app wrote both pass through
//! here, so that case, marks, letter variants, digits and joiners don't keep them apart.

use crate::Language;
use unicode_normalization::UnicodeNormalization;

/// A word compared in its normalized form, kept as it was said for text an app takes over.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Word {
    pub norm: String,
    pub said: String,
}

/// The normalized words of a text.
pub fn normalize(language: Language, text: &str) -> Vec<String> {
    words(language, text).into_iter().map(|word| word.norm).collect()
}

/// The words of a text, each normalized and as said.
pub fn words(language: Language, text: &str) -> Vec<Word> {
    let text: String = text.nfkc().map(ascii_digit).collect();
    let mut words = Vec::new();
    let mut said = String::new();
    // Turkish drops what follows an apostrophe – a case suffix on a name: "Yuhanna'yı".
    let mut suffix = false;
    let flush = |said: &mut String, words: &mut Vec<Word>| {
        if !said.is_empty() {
            push_word(language, said, words);
            said.clear();
        }
    };
    for c in text.chars() {
        if is_apostrophe(c) {
            if language == Language::Tr {
                suffix = true;
            }
        } else if is_joiner(c) {
            // Joiners and direction marks join: a Persian word written with a zero-width
            // non-joiner is the same word written without one.
        } else if c.is_alphanumeric() || is_mark(c) {
            if !suffix {
                said.push(c);
            }
        } else {
            flush(&mut said, &mut words);
            suffix = false;
        }
    }
    flush(&mut said, &mut words);
    words
}

/// One word as the matcher compares it: for an app's phrases, names and the number words.
pub fn fold(language: Language, word: &str) -> String {
    let word: String = word.nfkc().map(ascii_digit).collect();
    let lower = lowercase(language, &word);
    let mut folded = String::with_capacity(lower.len());
    for c in lower.chars() {
        fold_char(language, c, &mut folded);
    }
    folded
}

fn push_word(language: Language, said: &str, words: &mut Vec<Word>) {
    let norm = fold(language, said);
    if norm.is_empty() {
        return;
    }
    // A number with an ordinal ending – "3rd", "21.", "۳م" – is the number; with other letters
    // the two are words of their own.
    let digits = norm.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 && digits < norm.chars().count() {
        let (number, rest) = norm.split_at(digits);
        let said_digits: String = said.chars().take(digits).collect();
        words.push(Word { norm: number.to_string(), said: said_digits });
        if !ordinal_endings(language).contains(&rest) {
            let said_rest: String = said.chars().skip(digits).collect();
            words.push(Word { norm: rest.to_string(), said: said_rest });
        }
        return;
    }
    words.push(Word { norm, said: said.to_string() });
}

fn lowercase(language: Language, word: &str) -> String {
    if language == Language::Tr {
        word.chars()
            .map(|c| match c {
                'I' => "ı".to_string(),
                'İ' => "i".to_string(),
                c => c.to_lowercase().collect(),
            })
            .collect()
    } else {
        word.to_lowercase()
    }
}

fn fold_char(language: Language, c: char, out: &mut String) {
    match language {
        Language::En => {
            if !is_mark(c) {
                out.push(c);
            }
        }
        Language::De => match c {
            'ä' => out.push_str("ae"),
            'ö' => out.push_str("oe"),
            'ü' => out.push_str("ue"),
            'ß' => out.push_str("ss"),
            c if is_mark(c) => {}
            c => out.push(c),
        },
        // Recognizers and keyboards don't always write Turkish letters: folded on both sides,
        // "Yuhanna", "Kutsal Kitap" and "Bakara" match however they come.
        Language::Tr => match c {
            'ç' => out.push('c'),
            'ş' => out.push('s'),
            'ğ' => out.push('g'),
            'ı' => out.push('i'),
            'ö' => out.push('o'),
            'ü' => out.push('u'),
            'â' => out.push('a'),
            'î' => out.push('i'),
            'û' => out.push('u'),
            c if is_mark(c) => {}
            c => out.push(c),
        },
        Language::Ar => match c {
            'أ' | 'إ' | 'آ' | 'ٱ' => out.push('ا'),
            'ى' | 'ی' | 'ئ' => out.push('ي'),
            'ک' => out.push('ك'),
            'ة' | 'ۀ' => out.push('ه'),
            'ؤ' => out.push('و'),
            'ء' | 'ـ' => {}
            c if is_arabic_mark(c) || is_mark(c) => {}
            c => out.push(c),
        },
        Language::Fa => match c {
            'أ' | 'إ' | 'آ' | 'ٱ' => out.push('ا'),
            'ي' | 'ى' | 'ئ' => out.push('ی'),
            'ك' => out.push('ک'),
            'ة' | 'ۀ' => out.push('ه'),
            'ؤ' => out.push('و'),
            'ء' | 'ـ' => {}
            c if is_arabic_mark(c) || is_mark(c) => {}
            c => out.push(c),
        },
    }
}

/// Endings that make a number written in digits an ordinal.
pub(crate) fn ordinal_endings(language: Language) -> &'static [&'static str] {
    match language {
        Language::En => &["st", "nd", "rd", "th"],
        Language::De => &["te", "ten", "ter", "tem", "tes", "ste", "sten", "ster", "stem", "stes"],
        Language::Tr => &["inci", "nci", "uncu", "ncu"],
        Language::Ar => &[],
        Language::Fa => &["م", "ام", "مین", "امین"],
    }
}

fn ascii_digit(c: char) -> char {
    match c {
        '٠'..='٩' => char::from_digit(c as u32 - '٠' as u32, 10).unwrap_or(c),
        '۰'..='۹' => char::from_digit(c as u32 - '۰' as u32, 10).unwrap_or(c),
        c => c,
    }
}

fn is_apostrophe(c: char) -> bool {
    matches!(c, '\'' | '’' | 'ʼ' | '`' | '´')
}

fn is_joiner(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{061C}' | '\u{2060}' | '\u{FEFF}' | '\u{202A}'..='\u{202E}')
}

/// Combining marks, which stay with their letter while words are cut.
fn is_mark(c: char) -> bool {
    matches!(c, '\u{0300}'..='\u{036F}' | '\u{1AB0}'..='\u{1AFF}' | '\u{1DC0}'..='\u{1DFF}' | '\u{20D0}'..='\u{20FF}')
        || is_arabic_mark(c)
}

/// Arabic vowel signs, shadda, sukun, the dagger alef and the Quran's annotation signs.
fn is_arabic_mark(c: char) -> bool {
    matches!(c, '\u{0610}'..='\u{061A}' | '\u{064B}'..='\u{065F}' | '\u{0670}' | '\u{06D6}'..='\u{06ED}')
}

#[cfg(test)]
mod tests {
    use super::*;
    use Language::*;

    #[test]
    fn case_punctuation_and_digits() {
        assert_eq!(normalize(En, "Read John 3:16, please!"), ["read", "john", "3", "16", "please"]);
        assert_eq!(normalize(De, "Lies Psalm 139,14"), ["lies", "psalm", "139", "14"]);
        assert_eq!(normalize(En, "What's next?"), ["whats", "next"]);
        assert_eq!(normalize(En, "twenty-one"), ["twenty", "one"]);
    }

    #[test]
    fn german_umlauts_and_sharp_s() {
        assert_eq!(normalize(De, "Nächster Vers, Matthäus, dreißig"), ["naechster", "vers", "matthaeus", "dreissig"]);
        assert_eq!(normalize(De, "STRASSE Straße"), ["strasse", "strasse"]);
    }

    #[test]
    fn turkish_casing_letters_and_suffixes() {
        assert_eq!(normalize(Tr, "İKİ YÜZ Işık"), ["iki", "yuz", "isik"]);
        assert_eq!(normalize(Tr, "Yuhanna'yı oku"), ["yuhanna", "oku"]);
        assert_eq!(normalize(Tr, "3'üncü bölüm"), ["3", "bolum"]);
        assert_eq!(normalize(Tr, "3üncü"), ["3"]);
    }

    #[test]
    fn arabic_marks_and_letter_forms() {
        assert_eq!(normalize(Ar, "سُورَةُ البَقَرَة"), ["سوره", "البقره"]);
        assert_eq!(normalize(Ar, "الآية مِئَتَانِ وَخَمْسَةٌ"), ["الايه", "ميتان", "وخمسه"]);
        assert_eq!(normalize(Ar, "إِلَى ٢٥٥"), ["الي", "255"]);
        assert_eq!(normalize(Ar, "يُونُسَ ــ"), ["يونس"]);
    }

    #[test]
    fn persian_letters_digits_and_joiners() {
        // Arabic yeh and kaf, a zero-width non-joiner, Persian digits.
        assert_eq!(normalize(Fa, "سورهٔ يونس آيه ۲۵"), ["سوره", "یونس", "ایه", "25"]);
        assert_eq!(normalize(Fa, "می\u{200C}خواهم كتاب"), ["میخواهم", "کتاب"]);
        assert_eq!(normalize(Fa, "۳م"), ["3"]);
    }

    #[test]
    fn digits_with_other_letters_split() {
        assert_eq!(normalize(En, "3rd 2x"), ["3", "2", "x"]);
        let words = words(En, "John 3RD");
        assert_eq!(words[1], Word { norm: "3".into(), said: "3".into() });
    }

    #[test]
    fn said_keeps_the_original() {
        let words = words(De, "Suche nach Äpfeln");
        assert_eq!(words[2].said, "Äpfeln");
        assert_eq!(words[2].norm, "aepfeln");
    }
}
