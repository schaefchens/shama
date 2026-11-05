//! Numbers from 0 to 999 as people say them, and as recognizers write them: in digits, in words,
//! as German compounds ("zweihundertfünfundfünfzig"), Turkish and Persian ordinals ("üçüncü",
//! "سوم"), Arabic with its genders and cases ("مئتين وخمسة وخمسين"). One table per language both
//! reads them and spells them.

use crate::Language;
use crate::normalize::{fold, normalize};
use std::sync::OnceLock;

/// A number read at a place in a list of words.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Parsed {
    pub value: u32,
    /// How many words it took.
    pub len: usize,
    /// 0 for a reading word by word; 1 for each homophone it took ("for" as 4).
    pub cost: u32,
    pub ordinal: bool,
}

/// Every way the words from `start` on begin with a number: longest first, then cheapest.
pub fn parse_at(language: Language, words: &[String], start: usize) -> Vec<Parsed> {
    let Some(first) = words.get(start) else { return Vec::new() };
    if !first.is_empty() && first.len() <= 4 && first.bytes().all(|b| b.is_ascii_digit()) {
        let value = first.parse().unwrap_or(0);
        return vec![Parsed { value, len: 1, cost: 0, ordinal: false }];
    }
    let lexicon = lexicon(language);
    let mut found: Vec<Parsed> = Vec::new();
    // Each word's readings as morphemes; a longer span exists only while every word in it has one.
    let mut spans: Vec<Vec<Vec<&Morpheme>>> = Vec::new();
    for word in words.iter().skip(start).take(MAX_WORDS) {
        let segmentations = lexicon.segment(word);
        if segmentations.is_empty() {
            break;
        }
        spans.push(segmentations);
        let mut sequences: Vec<Vec<&Morpheme>> = vec![Vec::new()];
        for segmentations in &spans {
            let mut longer = Vec::new();
            for sequence in &sequences {
                for segmentation in segmentations {
                    if longer.len() >= MAX_SEQUENCES {
                        break;
                    }
                    let mut joined = sequence.clone();
                    joined.extend(segmentation.iter().copied());
                    longer.push(joined);
                }
            }
            sequences = longer;
        }
        for sequence in &sequences {
            if let Some((value, ordinal)) = lexicon.compose(sequence) {
                let cost = sequence.iter().map(|morpheme| morpheme.cost).sum();
                let parsed = Parsed { value, len: spans.len(), cost, ordinal };
                match found.iter_mut().find(|other| other.value == value && other.len == parsed.len) {
                    Some(other) if other.cost > cost => *other = parsed,
                    Some(_) => {}
                    None => found.push(parsed),
                }
            }
        }
    }
    found.sort_by(|a, b| b.len.cmp(&a.len).then(a.cost.cmp(&b.cost)));
    found
}

/// The whole of `text` as one number, if it is one.
pub fn parse(language: Language, text: &str) -> Option<u32> {
    let words = normalize(language, text);
    parse_at(language, &words, 0)
        .into_iter()
        .find(|parsed| parsed.len == words.len() && parsed.cost == 0)
        .map(|p| p.value)
}

/// The usual ways to say `n` (0–999) as a cardinal, the most common first.
pub fn spell(language: Language, n: u32) -> Vec<String> {
    assert!(n < 1000, "Shama spells numbers below 1000");
    match language {
        Language::En => spell_en(n),
        Language::De => spell_de(n),
        Language::Tr => spell_tr(n),
        Language::Ar => spell_ar(n),
        Language::Fa => spell_fa(n),
    }
}

const MAX_WORDS: usize = 6;
const MAX_SEQUENCES: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Kind {
    Zero,
    Unit(u32),
    Teen(u32),
    Ten(u32),
    Hundred,
    Hundreds(u32),
    /// "and", "und", "و" between the parts.
    And,
    /// Arabic "عشر": a unit before it makes a teen.
    TeenSuffix,
    /// Arabic "ال" on ordinals: "الخامس".
    Article,
    /// An ordinal ending on the last word: "-te", "-inci", "-م".
    OrdinalEnding,
}

#[derive(Debug)]
struct Morpheme {
    form: String,
    kind: Kind,
    ordinal: bool,
    cost: u32,
    /// English "a": a number only in "a hundred".
    before_hundred_only: bool,
    /// German "erst", "dritt": a number only with an ordinal ending.
    needs_ending: bool,
}

struct Lexicon {
    morphemes: Vec<Morpheme>,
    units_before_tens: bool,
}

fn lexicon(language: Language) -> &'static Lexicon {
    static LEXICONS: OnceLock<Vec<Lexicon>> = OnceLock::new();
    let lexicons = LEXICONS.get_or_init(|| Language::ALL.iter().map(|&language| build(language)).collect());
    &lexicons[Language::ALL.iter().position(|&l| l == language).unwrap_or(0)]
}

impl Lexicon {
    /// Every way a word splits fully into morphemes: "zweihundertfünfundfünfzig" into
    /// zwei|hundert|fünf|und|fünfzig, "وخمسون" into و|خمسون.
    fn segment(&self, word: &str) -> Vec<Vec<&Morpheme>> {
        let mut results = Vec::new();
        let mut path = Vec::new();
        self.segment_from(word, 0, &mut path, &mut results);
        results
    }

    fn segment_from<'a>(
        &'a self,
        word: &str,
        at: usize,
        path: &mut Vec<&'a Morpheme>,
        results: &mut Vec<Vec<&'a Morpheme>>,
    ) {
        if results.len() >= MAX_SEQUENCES {
            return;
        }
        if at == word.len() {
            if !path.is_empty() {
                results.push(path.clone());
            }
            return;
        }
        let rest = &word[at..];
        for morpheme in &self.morphemes {
            if !rest.starts_with(morpheme.form.as_str()) {
                continue;
            }
            let end = at + morpheme.form.len();
            match morpheme.kind {
                // An ending ends the word, after a number.
                Kind::OrdinalEnding if end != word.len() || path.is_empty() => continue,
                // The article begins a word, or follows its "و".
                Kind::Article if !(path.is_empty() || path.last().is_some_and(|m| m.kind == Kind::And)) => continue,
                _ => {}
            }
            path.push(morpheme);
            self.segment_from(word, end, path, results);
            path.pop();
        }
    }

    /// The value of a sequence of morphemes, if it is a well-formed number.
    fn compose(&self, sequence: &[&Morpheme]) -> Option<(u32, bool)> {
        let ordinal = sequence.iter().any(|morpheme| morpheme.ordinal || morpheme.kind == Kind::OrdinalEnding);
        for (i, morpheme) in sequence.iter().enumerate() {
            if morpheme.needs_ending && sequence.get(i + 1).is_none_or(|next| next.kind != Kind::OrdinalEnding) {
                return None;
            }
            if morpheme.before_hundred_only && sequence.get(i + 1).is_none_or(|next| next.kind != Kind::Hundred) {
                return None;
            }
        }
        let parts: Vec<Kind> =
            sequence.iter().map(|morpheme| morpheme.kind).filter(|kind| !matches!(kind, Kind::Article)).collect();
        let (value, used) = self.compose_parts(&parts)?;
        let rest = &parts[used..];
        match rest {
            [] => Some((value, ordinal)),
            [Kind::OrdinalEnding] => Some((value, true)),
            _ => None,
        }
    }

    fn compose_parts(&self, parts: &[Kind]) -> Option<(u32, usize)> {
        use Kind::*;
        if parts.first() == Some(&Zero) {
            return Some((0, 1));
        }
        let mut i = 0;
        let mut total = 0;
        let mut any = false;
        match (parts.first(), parts.get(1)) {
            (Some(Hundreds(value)), _) => {
                total = *value;
                i = 1;
                any = true;
            }
            (Some(Unit(unit)), Some(Hundred)) => {
                total = unit * 100;
                i = 2;
                any = true;
            }
            (Some(Hundred), _) => {
                total = 100;
                i = 1;
                any = true;
            }
            _ => {}
        }
        if any && parts.get(i) == Some(&And) && parts.len() > i + 1 {
            i += 1;
        }
        match parts.get(i) {
            Some(Teen(teen)) => {
                total += teen;
                i += 1;
                any = true;
            }
            Some(Ten(ten)) => {
                total += ten;
                i += 1;
                any = true;
                if !self.units_before_tens {
                    let unit_at = if parts.get(i) == Some(&And) { i + 1 } else { i };
                    if let Some(Unit(unit)) = parts.get(unit_at) {
                        total += unit;
                        i = unit_at + 1;
                    }
                }
            }
            Some(Unit(unit)) => {
                any = true;
                match (parts.get(i + 1), parts.get(i + 2)) {
                    (Some(And), Some(Ten(ten))) if self.units_before_tens => {
                        total += unit + ten;
                        i += 3;
                    }
                    (Some(TeenSuffix), _) => {
                        total += 10 + unit;
                        i += 2;
                    }
                    _ => {
                        total += unit;
                        i += 1;
                    }
                }
            }
            Some(TeenSuffix) => {
                total += 10;
                i += 1;
                any = true;
            }
            _ => {}
        }
        any.then_some((total, i))
    }
}

/// A language's number words, folded as the matcher compares them.
fn build(language: Language) -> Lexicon {
    let mut morphemes = Vec::new();
    let mut add = |forms: &[&str], kind: Kind, ordinal: bool| {
        for form in forms {
            morphemes.push(Morpheme {
                form: fold(language, form),
                kind,
                ordinal,
                cost: 0,
                before_hundred_only: false,
                needs_ending: false,
            });
        }
    };
    use Kind::*;
    let units_before_tens;
    match language {
        Language::En => {
            units_before_tens = false;
            for (value, forms) in [
                (1, &["one"][..]),
                (2, &["two"]),
                (3, &["three"]),
                (4, &["four"]),
                (5, &["five"]),
                (6, &["six"]),
                (7, &["seven"]),
                (8, &["eight"]),
                (9, &["nine"]),
            ] {
                add(forms, Unit(value), false);
            }
            for (value, forms) in [
                (1, &["first"][..]),
                (2, &["second"]),
                (3, &["third"]),
                (4, &["fourth"]),
                (5, &["fifth"]),
                (6, &["sixth"]),
                (7, &["seventh"]),
                (8, &["eighth"]),
                (9, &["ninth"]),
            ] {
                add(forms, Unit(value), true);
            }
            for (value, cardinal, ordinal) in [
                (10, "ten", "tenth"),
                (11, "eleven", "eleventh"),
                (12, "twelve", "twelfth"),
                (13, "thirteen", "thirteenth"),
                (14, "fourteen", "fourteenth"),
                (15, "fifteen", "fifteenth"),
                (16, "sixteen", "sixteenth"),
                (17, "seventeen", "seventeenth"),
                (18, "eighteen", "eighteenth"),
                (19, "nineteen", "nineteenth"),
            ] {
                add(&[cardinal], Teen(value), false);
                add(&[ordinal], Teen(value), true);
            }
            for (value, cardinal, ordinal) in [
                (20, &["twenty"][..], "twentieth"),
                (30, &["thirty"], "thirtieth"),
                (40, &["forty", "fourty"], "fortieth"),
                (50, &["fifty"], "fiftieth"),
                (60, &["sixty"], "sixtieth"),
                (70, &["seventy"], "seventieth"),
                (80, &["eighty"], "eightieth"),
                (90, &["ninety"], "ninetieth"),
            ] {
                add(cardinal, Ten(value), false);
                add(&[ordinal], Ten(value), true);
            }
            add(&["hundred"], Hundred, false);
            add(&["hundredth"], Hundred, true);
            add(&["and"], And, false);
            add(&["zero"], Zero, false);
            morphemes.push(Morpheme {
                form: "a".into(),
                kind: Unit(1),
                ordinal: false,
                cost: 0,
                before_hundred_only: true,
                needs_ending: false,
            });
            // Words recognizers write for a number they heard: they count as an edit.
            for (form, value) in [("won", 1), ("to", 2), ("too", 2), ("for", 4), ("fore", 4), ("ate", 8)] {
                morphemes.push(Morpheme {
                    form: form.into(),
                    kind: Unit(value),
                    ordinal: false,
                    cost: 1,
                    before_hundred_only: false,
                    needs_ending: false,
                });
            }
        }
        Language::De => {
            units_before_tens = true;
            for (value, forms) in [
                (1, &["eins", "ein", "eine"][..]),
                (2, &["zwei", "zwo"]),
                (3, &["drei"]),
                (4, &["vier"]),
                (5, &["fünf"]),
                (6, &["sechs"]),
                (7, &["sieben"]),
                (8, &["acht"]),
                (9, &["neun"]),
            ] {
                add(forms, Unit(value), false);
            }
            for (value, form) in [
                (10, "zehn"),
                (11, "elf"),
                (12, "zwölf"),
                (13, "dreizehn"),
                (14, "vierzehn"),
                (15, "fünfzehn"),
                (16, "sechzehn"),
                (17, "siebzehn"),
                (18, "achtzehn"),
                (19, "neunzehn"),
            ] {
                add(&[form], Teen(value), false);
            }
            for (value, form) in [
                (20, "zwanzig"),
                (30, "dreißig"),
                (40, "vierzig"),
                (50, "fünfzig"),
                (60, "sechzig"),
                (70, "siebzig"),
                (80, "achtzig"),
                (90, "neunzig"),
            ] {
                add(&[form], Ten(value), false);
            }
            add(&["hundert"], Hundred, false);
            add(&["und"], And, false);
            add(&["null"], Zero, false);
            add(
                &["te", "ten", "ter", "tem", "tes", "ste", "sten", "ster", "stem", "stes", "e", "en", "er", "em", "es"],
                OrdinalEnding,
                true,
            );
            for (form, value) in [("erst", 1), ("dritt", 3), ("siebt", 7)] {
                morphemes.push(Morpheme {
                    form: form.into(),
                    kind: Unit(value),
                    ordinal: true,
                    cost: 0,
                    before_hundred_only: false,
                    needs_ending: true,
                });
            }
        }
        Language::Tr => {
            units_before_tens = false;
            for (value, forms) in [
                (1, &["bir"][..]),
                (2, &["iki"]),
                (3, &["üç"]),
                (4, &["dört", "dörd"]),
                (5, &["beş"]),
                (6, &["altı"]),
                (7, &["yedi"]),
                (8, &["sekiz"]),
                (9, &["dokuz"]),
            ] {
                add(forms, Unit(value), false);
            }
            add(&["ilk"], Unit(1), true);
            for (value, form) in [
                (10, "on"),
                (20, "yirmi"),
                (30, "otuz"),
                (40, "kırk"),
                (50, "elli"),
                (60, "altmış"),
                (70, "yetmiş"),
                (80, "seksen"),
                (90, "doksan"),
            ] {
                add(&[form], Ten(value), false);
            }
            add(&["yüz"], Hundred, false);
            add(&["sıfır"], Zero, false);
            add(&["inci", "ıncı", "uncu", "üncü", "nci", "ncı", "ncu", "ncü"], OrdinalEnding, true);
        }
        Language::Ar => {
            units_before_tens = true;
            for (value, forms) in [
                (1, &["واحد", "واحدة", "أحد", "إحدى"][..]),
                (2, &["اثنان", "اثنين", "اثنتان", "اثنتين", "اثنا", "اثني", "اثنتا", "اثنتي"]),
                (3, &["ثلاثة", "ثلاث"]),
                (4, &["أربعة", "أربع"]),
                (5, &["خمسة", "خمس"]),
                (6, &["ستة", "ست"]),
                (7, &["سبعة", "سبع"]),
                (8, &["ثمانية", "ثماني", "ثمان"]),
                (9, &["تسعة", "تسع"]),
            ] {
                add(forms, Unit(value), false);
            }
            for (value, forms) in [
                (1, &["أول", "أولى", "حادي", "حادية"][..]),
                (2, &["ثاني", "ثانية"]),
                (3, &["ثالث", "ثالثة"]),
                (4, &["رابع", "رابعة"]),
                (5, &["خامس", "خامسة"]),
                (6, &["سادس", "سادسة"]),
                (7, &["سابع", "سابعة"]),
                (8, &["ثامن", "ثامنة"]),
                (9, &["تاسع", "تاسعة"]),
            ] {
                add(forms, Unit(value), true);
            }
            add(&["عشرة", "عشر"], TeenSuffix, false);
            add(&["عاشر", "عاشرة"], TeenSuffix, true);
            for (value, forms) in [
                (20, &["عشرون", "عشرين"][..]),
                (30, &["ثلاثون", "ثلاثين"]),
                (40, &["أربعون", "أربعين"]),
                (50, &["خمسون", "خمسين"]),
                (60, &["ستون", "ستين"]),
                (70, &["سبعون", "سبعين"]),
                (80, &["ثمانون", "ثمانين"]),
                (90, &["تسعون", "تسعين"]),
            ] {
                add(forms, Ten(value), false);
            }
            add(&["مائة", "مئة"], Hundred, false);
            add(&["مئتان", "مئتين", "مائتان", "مائتين"], Hundreds(200), false);
            add(&["و"], And, false);
            add(&["ال"], Article, false);
            add(&["صفر"], Zero, false);
        }
        Language::Fa => {
            units_before_tens = false;
            for (value, forms) in [
                (1, &["یک"][..]),
                (2, &["دو"]),
                (3, &["سه"]),
                (4, &["چهار"]),
                (5, &["پنج"]),
                (6, &["شش", "شیش"]),
                (7, &["هفت"]),
                (8, &["هشت"]),
                (9, &["نه"]),
            ] {
                add(forms, Unit(value), false);
            }
            add(&["اول", "اولین", "نخست", "نخستین"], Unit(1), true);
            add(&["سوم", "سومین"], Unit(3), true);
            for (value, forms) in [
                (10, &["ده"][..]),
                (11, &["یازده"]),
                (12, &["دوازده"]),
                (13, &["سیزده"]),
                (14, &["چهارده"]),
                (15, &["پانزده", "پونزده"]),
                (16, &["شانزده", "شونزده"]),
                (17, &["هفده", "هیفده"]),
                (18, &["هجده", "هیجده", "هژده"]),
                (19, &["نوزده"]),
            ] {
                add(forms, Teen(value), false);
            }
            for (value, form) in [
                (20, "بیست"),
                (30, "سی"),
                (40, "چهل"),
                (50, "پنجاه"),
                (60, "شصت"),
                (70, "هفتاد"),
                (80, "هشتاد"),
                (90, "نود"),
            ] {
                add(&[form], Ten(value), false);
            }
            add(&["صد"], Hundred, false);
            add(&["دویست"], Hundreds(200), false);
            add(&["سیصد"], Hundreds(300), false);
            add(&["پانصد", "پونصد"], Hundreds(500), false);
            add(&["و"], And, false);
            add(&["صفر"], Zero, false);
            add(&["م", "ام", "مین", "امین"], OrdinalEnding, true);
        }
    }
    // Folding makes some forms the same (Turkish "ıncı" and "inci"): each once.
    let mut seen = std::collections::HashSet::new();
    morphemes.retain(|m| seen.insert((m.form.clone(), m.kind, m.ordinal)));
    Lexicon { morphemes, units_before_tens }
}

fn spell_en(n: u32) -> Vec<String> {
    const UNITS: [&str; 10] = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
    const TEENS: [&str; 10] =
        ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
    const TENS: [&str; 10] = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
    if n == 0 {
        return vec!["zero".into()];
    }
    let rest = |r: u32| match r {
        0 => String::new(),
        1..=9 => UNITS[r as usize].to_string(),
        10..=19 => TEENS[(r - 10) as usize].to_string(),
        _ if r.is_multiple_of(10) => TENS[(r / 10) as usize].to_string(),
        _ => format!("{} {}", TENS[(r / 10) as usize], UNITS[(r % 10) as usize]),
    };
    let (h, r) = (n / 100, n % 100);
    if h == 0 {
        return vec![rest(r)];
    }
    let hundreds = format!("{} hundred", UNITS[h as usize]);
    if r == 0 {
        return vec![hundreds];
    }
    vec![format!("{hundreds} and {}", rest(r)), format!("{hundreds} {}", rest(r))]
}

fn spell_de(n: u32) -> Vec<String> {
    const UNITS: [&str; 10] = ["", "ein", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun"];
    const TEENS: [&str; 10] =
        ["zehn", "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn"];
    const TENS: [&str; 10] =
        ["", "", "zwanzig", "dreißig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig", "neunzig"];
    if n == 0 {
        return vec!["null".into()];
    }
    let rest = |r: u32| match r {
        0 => String::new(),
        1 => "eins".into(),
        2..=9 => UNITS[r as usize].to_string(),
        10..=19 => TEENS[(r - 10) as usize].to_string(),
        _ if r.is_multiple_of(10) => TENS[(r / 10) as usize].to_string(),
        _ => format!("{}und{}", UNITS[(r % 10) as usize], TENS[(r / 10) as usize]),
    };
    let (h, r) = (n / 100, n % 100);
    if h == 0 {
        return vec![rest(r)];
    }
    let hundreds = format!("{}hundert", UNITS[h as usize]);
    if r == 0 {
        return if h == 1 { vec![hundreds, "hundert".into()] } else { vec![hundreds] };
    }
    vec![format!("{hundreds}{}", rest(r)), format!("{hundreds} {}", rest(r))]
}

fn spell_tr(n: u32) -> Vec<String> {
    const UNITS: [&str; 10] = ["", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz"];
    const TENS: [&str; 10] = ["", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan"];
    if n == 0 {
        return vec!["sıfır".into()];
    }
    let mut words = Vec::new();
    let (h, t, u) = (n / 100, n / 10 % 10, n % 10);
    if h == 1 {
        words.push("yüz".to_string());
    } else if h > 1 {
        words.push(format!("{} yüz", UNITS[h as usize]));
    }
    if t > 0 {
        words.push(TENS[t as usize].to_string());
    }
    if u > 0 {
        words.push(UNITS[u as usize].to_string());
    }
    let spaced = words.join(" ");
    let fused = spaced.replace(' ', "");
    if fused == spaced { vec![spaced] } else { vec![spaced, fused] }
}

fn spell_ar(n: u32) -> Vec<String> {
    const UNITS: [&str; 10] = ["", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة"];
    const UNITS_GENITIVE: [&str; 10] = ["", "واحد", "اثنين", "ثلاث", "أربع", "خمس", "ست", "سبع", "ثماني", "تسع"];
    const TENS: [&str; 10] = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"];
    const TENS_GENITIVE: [&str; 10] = ["", "", "عشرين", "ثلاثين", "أربعين", "خمسين", "ستين", "سبعين", "ثمانين", "تسعين"];
    const HUNDREDS: [&str; 10] =
        ["", "مائة", "مئتان", "ثلاثمائة", "أربعمائة", "خمسمائة", "ستمائة", "سبعمائة", "ثمانمائة", "تسعمائة"];
    const HUNDREDS_GENITIVE: [&str; 10] =
        ["", "مئة", "مئتين", "ثلاثمئة", "أربعمئة", "خمسمئة", "ستمئة", "سبعمئة", "ثمانمئة", "تسعمئة"];
    if n == 0 {
        return vec!["صفر".into()];
    }
    let rest = |r: u32, units: &[&str; 10], tens: &[&str; 10]| match r {
        0 => String::new(),
        1..=9 => units[r as usize].to_string(),
        10 => "عشرة".into(),
        11 => "أحد عشر".into(),
        12 => {
            if units == &UNITS {
                "اثنا عشر".into()
            } else {
                "اثني عشر".into()
            }
        }
        13..=19 => format!("{} عشر", units[(r - 10) as usize]),
        _ if r.is_multiple_of(10) => tens[(r / 10) as usize].to_string(),
        _ => format!("{} و{}", units[(r % 10) as usize], tens[(r / 10) as usize]),
    };
    let (h, r) = (n / 100, n % 100);
    let mut spellings = Vec::new();
    for (units, tens, hundreds) in [(&UNITS, &TENS, &HUNDREDS), (&UNITS_GENITIVE, &TENS_GENITIVE, &HUNDREDS_GENITIVE)] {
        let spelling = match (h, r) {
            (0, r) => rest(r, units, tens),
            (h, 0) => hundreds[h as usize].to_string(),
            (h, r) => format!("{} و{}", hundreds[h as usize], rest(r, units, tens)),
        };
        if !spellings.contains(&spelling) {
            spellings.push(spelling);
        }
    }
    spellings
}

fn spell_fa(n: u32) -> Vec<String> {
    const UNITS: [&str; 10] = ["", "یک", "دو", "سه", "چهار", "پنج", "شش", "هفت", "هشت", "نه"];
    const TEENS: [&str; 10] = ["ده", "یازده", "دوازده", "سیزده", "چهارده", "پانزده", "شانزده", "هفده", "هجده", "نوزده"];
    const TENS: [&str; 10] = ["", "", "بیست", "سی", "چهل", "پنجاه", "شصت", "هفتاد", "هشتاد", "نود"];
    const HUNDREDS: [&str; 10] = ["", "صد", "دویست", "سیصد", "چهارصد", "پانصد", "ششصد", "هفتصد", "هشتصد", "نهصد"];
    if n == 0 {
        return vec!["صفر".into()];
    }
    let (h, r) = (n / 100, n % 100);
    let mut parts = Vec::new();
    if h > 0 {
        parts.push(HUNDREDS[h as usize].to_string());
    }
    match r {
        0 => {}
        1..=9 => parts.push(UNITS[r as usize].into()),
        10..=19 => parts.push(TEENS[(r - 10) as usize].into()),
        _ => {
            parts.push(TENS[(r / 10) as usize].into());
            if r % 10 > 0 {
                parts.push(UNITS[(r % 10) as usize].into());
            }
        }
    }
    let joined = parts.join(" و ");
    if n == 100 { vec![joined, "یکصد".into()] } else { vec![joined] }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Language::*;

    fn read(language: Language, text: &str) -> Option<u32> {
        parse(language, text)
    }

    #[test]
    fn every_spelling_reads_back() {
        for language in Language::ALL {
            for n in 0..1000 {
                for spelling in spell(language, n) {
                    assert_eq!(read(language, &spelling), Some(n), "{language}: {spelling}");
                }
            }
        }
    }

    #[test]
    fn digits_in_any_script() {
        assert_eq!(read(Ar, "٢٥٥"), Some(255));
        assert_eq!(read(Fa, "۱۳۹"), Some(139));
        assert_eq!(read(En, "176"), Some(176));
    }

    #[test]
    fn english() {
        assert_eq!(read(En, "a hundred and nineteen"), Some(119));
        assert_eq!(read(En, "twenty-first"), Some(21));
        assert_eq!(read(En, "one hundred and nineteenth"), Some(119));
        assert_eq!(read(En, "a"), None);
        // Homophones read, at a cost: an exact reading wins.
        assert_eq!(parse_at(En, &normalize(En, "for"), 0)[0].cost, 1);
    }

    #[test]
    fn german_compounds_and_ordinals() {
        assert_eq!(read(De, "zweihundertfünfundfünfzig"), Some(255));
        assert_eq!(read(De, "hundertneununddreißig"), Some(139));
        assert_eq!(read(De, "einhundertneunzehnte"), Some(119));
        assert_eq!(read(De, "dritten"), Some(3));
        assert_eq!(read(De, "siebte"), Some(7));
        assert_eq!(read(De, "zwanzigsten"), Some(20));
        assert_eq!(read(De, "zwo"), Some(2));
        assert_eq!(read(De, "erst"), None);
    }

    #[test]
    fn turkish_ordinals() {
        assert_eq!(read(Tr, "üçüncü"), Some(3));
        assert_eq!(read(Tr, "dördüncü"), Some(4));
        assert_eq!(read(Tr, "yüz on dokuzuncu"), Some(119));
        assert_eq!(read(Tr, "ilk"), Some(1));
        assert_eq!(read(Tr, "ikiyüzellibeş"), Some(255));
    }

    #[test]
    fn arabic_cases_genders_and_ordinals() {
        assert_eq!(read(Ar, "مِئَتَيْنِ وَخَمْسٍ وَخَمْسِين"), Some(255));
        assert_eq!(read(Ar, "مائة وتسعة عشر"), Some(119));
        assert_eq!(read(Ar, "الخامس والخمسون"), Some(55));
        assert_eq!(read(Ar, "الحادي عشر"), Some(11));
        assert_eq!(read(Ar, "ثلاث مائة"), Some(300));
        assert_eq!(read(Ar, "العاشرة"), Some(10));
    }

    #[test]
    fn persian_ordinals_and_colloquial() {
        assert_eq!(read(Fa, "دویست و پنجاه و پنجم"), Some(255));
        assert_eq!(read(Fa, "سی\u{200C}ام"), Some(30));
        assert_eq!(read(Fa, "سوم"), Some(3));
        assert_eq!(read(Fa, "پونزده"), Some(15));
        assert_eq!(read(Fa, "اولین"), Some(1));
        assert_eq!(read(Fa, "یکصد و نوزده"), Some(119));
    }

    #[test]
    fn a_number_and_the_next_one() {
        let words = normalize(En, "three sixteen");
        let first = parse_at(En, &words, 0);
        assert_eq!(first[0], Parsed { value: 3, len: 1, cost: 0, ordinal: false });
        assert_eq!(parse_at(En, &words, 1)[0].value, 16);
        let words = normalize(En, "twenty one");
        assert_eq!(parse_at(En, &words, 0)[0], Parsed { value: 21, len: 2, cost: 0, ordinal: false });
        assert!(parse_at(En, &words, 0).iter().any(|p| p.value == 20 && p.len == 1));
    }
}
