// The scorer's text normalization for en, de, tr, ar and fa: case, punctuation, letter variants
// and diacritics folded the same way on both sides, number words turned into digits. Deliberately
// lenient – it decides whether a hearing was right, not how Shama matches.

const FOLD = {
  de: [[/ä/g, 'a'], [/ö/g, 'o'], [/ü/g, 'u'], [/ß/g, 'ss']],
  tr: [[/ç/g, 'c'], [/ğ/g, 'g'], [/ı/g, 'i'], [/ö/g, 'o'], [/ş/g, 's'], [/ü/g, 'u'], [/â/g, 'a'], [/î/g, 'i'], [/û/g, 'u']],
  ar: [[/[ً-ٰٟۖ-ۭـ]/g, ''], [/[أإآٱ]/g, 'ا'], [/ى/g, 'ي'], [/ة/g, 'ه'], [/ؤ/g, 'و'], [/ئ/g, 'ي'], [/ء/g, ''], [/[یی]/g, 'ي'], [/ک/g, 'ك']],
  fa: [[/[ً-ٰٟۖ-ۭـ]/g, ''], [/[أإآٱ]/g, 'ا'], [/[يى]/g, 'ی'], [/ك/g, 'ک'], [/[ةۀ]/g, 'ه'], [/ؤ/g, 'و'], [/ئ/g, 'ی'], [/ء/g, ''], [/‌/g, '']],
};

function lower(lang, text) {
  if (lang === 'tr') return text.replace(/I/g, 'ı').replace(/İ/g, 'i').toLowerCase();
  return text.toLowerCase();
}

// Number words: per language, morphemes of kinds U (0–9), T (10–19), D (tens), H (×100),
// V (a lexical hundreds value), C (a connector), X (Arabic عشر after a unit), A (article, ignored).
const LEXICON = {
  en: {
    U: { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9 },
    T: { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19 },
    D: { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90 },
    H: { hundred: 100, hundredth: 100 },
    C: { and: 0 },
  },
  de: {
    U: { null: 0, ein: 1, eins: 1, eine: 1, einen: 1, einem: 1, einer: 1, zwei: 2, zwo: 2, drei: 3, vier: 4, funf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, erst: 1, dritt: 3, siebt: 7, siebent: 7 },
    T: { zehn: 10, elf: 11, zwolf: 12, dreizehn: 13, vierzehn: 14, funfzehn: 15, sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19 },
    D: { zwanzig: 20, dreissig: 30, vierzig: 40, funfzig: 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90 },
    H: { hundert: 100, einhundert: 100 },
    C: { und: 0 },
  },
  tr: {
    U: { sifir: 0, bir: 1, iki: 2, uc: 3, dort: 4, bes: 5, alti: 6, yedi: 7, sekiz: 8, dokuz: 9, birinci: 1, ilk: 1, ikinci: 2, ucuncu: 3, dorduncu: 4, besinci: 5, altinci: 6, yedinci: 7, sekizinci: 8, dokuzuncu: 9 },
    D: { on: 10, yirmi: 20, otuz: 30, kirk: 40, elli: 50, altmis: 60, yetmis: 70, seksen: 80, doksan: 90, onuncu: 10, yirminci: 20, otuzuncu: 30, kirkinci: 40, ellinci: 50, altmisinci: 60, yetmisinci: 70, sekseninci: 80, doksaninci: 90 },
    H: { yuz: 100, yuzuncu: 100 },
  },
  ar: {
    U: { صفر: 0, واحد: 1, واحده: 1, احد: 1, احدي: 1, حادي: 1, اول: 1, اولي: 1, اثنان: 2, اثنين: 2, اثنتان: 2, اثنتين: 2, اثنا: 2, اثني: 2, ثاني: 2, ثانيه: 2, ثلاث: 3, ثلاثه: 3, ثالث: 3, ثالثه: 3, اربع: 4, اربعه: 4, رابع: 4, رابعه: 4, خمس: 5, خمسه: 5, خامس: 5, خامسه: 5, ست: 6, سته: 6, سادس: 6, سادسه: 6, سبع: 7, سبعه: 7, سابع: 7, سابعه: 7, ثمان: 8, ثماني: 8, ثمانيه: 8, ثامن: 8, ثامنه: 8, تسع: 9, تسعه: 9, تاسع: 9, تاسعه: 9 },
    T: { عاشر: 10, عاشره: 10 },
    X: { عشر: 10, عشره: 10 },
    D: { عشرون: 20, عشرين: 20, ثلاثون: 30, ثلاثين: 30, اربعون: 40, اربعين: 40, خمسون: 50, خمسين: 50, ستون: 60, ستين: 60, سبعون: 70, سبعين: 70, ثمانون: 80, ثمانين: 80, تسعون: 90, تسعين: 90 },
    H: { مائه: 100, مئه: 100, مايه: 100 },
    V: { مائتان: 200, مائتين: 200, مئتان: 200, مئتين: 200, ثلاثمائه: 300, ثلاثمئه: 300, اربعمائه: 400, اربعمئه: 400, خمسمائه: 500, خمسمئه: 500, ستمائه: 600, ستمئه: 600, سبعمائه: 700, سبعمئه: 700, ثمانمائه: 800, ثمانمئه: 800, تسعمائه: 900, تسعمئه: 900 },
    C: { و: 0 },
    A: { ال: 0 },
  },
  fa: {
    U: { صفر: 0, یک: 1, دو: 2, سه: 3, چهار: 4, پنج: 5, شش: 6, شیش: 6, هفت: 7, هشت: 8, نه: 9, اول: 1, نخست: 1, سوم: 3 },
    T: { ده: 10, یازده: 11, دوازده: 12, سیزده: 13, چهارده: 14, پانزده: 15, پونزده: 15, شانزده: 16, شونزده: 16, هفده: 17, هیفده: 17, هجده: 18, هیجده: 18, هژده: 18, نوزده: 19 },
    D: { بیست: 20, سی: 30, چهل: 40, پنجاه: 50, شصت: 60, هفتاد: 70, هشتاد: 80, نود: 90 },
    H: { صد: 100, یکصد: 100 },
    V: { دویست: 200, سیصد: 300, چهارصد: 400, پانصد: 500, پونصد: 500, ششصد: 600, هفتصد: 700, هشتصد: 800, نهصد: 900 },
    C: { و: 0 },
  },
};

// The lexicon is written as people spell; text is matched after folding, so fold it too.
const fold = (lang, word) => (FOLD[lang] ?? []).reduce((w, [from, to]) => w.replace(from, to), word);
const MORPHEMES = Object.fromEntries(
  Object.entries(LEXICON).map(([lang, kinds]) => [
    lang,
    Object.entries(kinds).flatMap(([kind, words]) => Object.entries(words).map(([word, value]) => ({ word: fold(lang, word), kind, value }))),
  ]),
);

// Splits a token wholly into number morphemes, or returns null.
function segment(lang, token) {
  const morphemes = MORPHEMES[lang];
  const best = new Array(token.length + 1).fill(null);
  best[0] = [];
  for (let i = 0; i < token.length; i++) {
    if (!best[i]) continue;
    for (const m of morphemes) {
      if (token.startsWith(m.word, i) && (!best[i + m.word.length] || best[i + m.word.length].length > best[i].length + 1)) {
        best[i + m.word.length] = [...best[i], m];
      }
    }
  }
  const parts = best[token.length];
  if (!parts || parts.every((m) => m.kind === 'A')) return null;
  return parts;
}

// German, Turkish and Persian ordinal endings on a number's last morpheme.
function ordinal(lang, token) {
  const tries = {
    de: [/^(.+?)(?:ste|te|e)(?:n|r|m|s)?$/],
    fa: [/^(.+?)(?:امین|مین|ام|م)$/],
  }[lang];
  for (const pattern of tries ?? []) {
    const match = token.match(pattern);
    if (match) {
      const parts = segment(lang, match[1]);
      if (parts) return parts;
    }
  }
  return null;
}

// Reads one number starting at morpheme i; returns [value, next] or null.
function readNumber(m, i) {
  const at = (k, kinds) => m[k] && kinds.includes(m[k].kind);
  let value = 0;
  let j = i;
  let any = false;
  if (at(j, ['V'])) [value, j, any] = [m[j].value, j + 1, true];
  else if (at(j, ['U']) && at(j + 1, ['H'])) [value, j, any] = [m[j].value * 100, j + 2, true];
  else if (at(j, ['H'])) [value, j, any] = [100, j + 1, true];
  if (any && at(j, ['C']) && at(j + 1, ['U', 'T', 'D'])) j += 1;
  if (at(j, ['T'])) [value, j, any] = [value + m[j].value, j + 1, true];
  else if (at(j, ['U']) && at(j + 1, ['X'])) [value, j, any] = [value + m[j].value + 10, j + 2, true];
  else if (at(j, ['X'])) [value, j, any] = [value + 10, j + 1, true];
  else if (at(j, ['D'])) {
    value += m[j].value;
    j += 1;
    any = true;
    if (at(j, ['C']) && at(j + 1, ['U'])) [value, j] = [value + m[j + 1].value, j + 2];
    else if (at(j, ['U'])) [value, j] = [value + m[j].value, j + 1];
  } else if (at(j, ['U'])) {
    if (at(j + 1, ['C']) && at(j + 2, ['D'])) [value, j] = [value + m[j].value + m[j + 2].value, j + 3];
    else if (at(j + 1, ['D'])) [value, j] = [value + m[j].value + m[j + 1].value, j + 2];
    else [value, j] = [value + m[j].value, j + 1];
    any = true;
  }
  return any ? [value, j] : null;
}

export function numbersToDigits(lang, tokens) {
  // Morphemes, each remembering its token, so words that aren't numbers stay as they are.
  const stream = [];
  for (const token of tokens) {
    const stripped = lang === 'ar' && token.startsWith('ال') ? token : token;
    const parts = segment(lang, stripped) ?? ordinal(lang, stripped);
    if (parts) for (const p of parts) if (p.kind !== 'A') stream.push({ ...p, token });
    if (!parts) stream.push({ kind: 'W', word: token });
  }
  const out = [];
  for (let i = 0; i < stream.length; ) {
    if (stream[i].kind === 'W') {
      out.push(stream[i++].word);
      continue;
    }
    const read = readNumber(stream, i);
    if (!read) {
      out.push(stream[i].token);
      // Skip the rest of this token's morphemes.
      const token = stream[i].token;
      i += 1;
      while (stream[i] && stream[i].kind !== 'W' && stream[i].token === token) i += 1;
      continue;
    }
    out.push(String(read[0]));
    i = read[1];
  }
  // A connector left alone between digits ("3 و 5") stays a word.
  return out;
}

export function normalize(lang, text) {
  let s = text.normalize('NFKC');
  s = s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  s = lower(lang, s);
  for (const [from, to] of FOLD[lang] ?? []) s = s.replace(from, to);
  // Turkish suffixes after an apostrophe ("Yuhanna'nın", "3'üncü") go.
  if (lang === 'tr') s = s.replace(/['’][\p{L}]+/gu, '');
  s = s.replace(/[‎‏؜]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ');
  // Digits glued to letters ("3rd", "16th") keep the digits.
  if (lang === 'en') s = s.replace(/(\d+)(st|nd|rd|th)\b/g, '$1');
  const tokens = s.split(/\s+/).filter(Boolean);
  return numbersToDigits(lang, tokens);
}
