// Cleans raw OCR text WITHOUT changing its meaning.
//
// The rule that shapes everything here: a wrong "fix" is worse than an honest error.
// A misread digit is caught later by validation and review; a word or an ID that we
// "corrected" wrongly looks perfectly fine and nobody will ever notice.
// So: ordinary words are never touched, and character swaps happen only inside
// tokens that clearly have the shape of an amount or a whole number.

const MAX_RECORDED_FIXES = 100; // the count keeps going; only the stored list is capped

// ---------------------------------------------------------------- 1. whitespace
const normalizeWhitespace = (text) =>
    String(text ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width characters
        .replace(/[\u00A0\u2002-\u2009\u202F]/g, " ") // non-breaking and thin spaces become a normal space
        .replace(/\t/g, "  ") // a tab is a column gap; keep it as one
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "") // control characters (not newline)
        .split("\n")
        .map((line) => line.trim()) // NOTE: spaces INSIDE a line are kept, the parser reads 2+ spaces as a column gap
        .join("\n")
        .replace(/\n{3,}/g, "\n\n") // at most one blank line in a row
        .trim();

// ---------------------------------------------------------------- 2. currency symbols
// Only unambiguous look-alikes. We never invent a currency the page does not show.
const SYMBOL_FIXES = [
    { pattern: /\u20A8/g, to: "Rs.", name: "rupee sign variant" }, // the old "rupee" glyph
    { pattern: /\uFF04|\uFE69/g, to: "$", name: "wide dollar sign" },
    { pattern: /\uFFE1/g, to: "\u00A3", name: "wide pound sign" },
    { pattern: /\uFFE5/g, to: "\u00A5", name: "wide yen sign" },
];
// Tesseract's English data has no rupee glyph, so it often prints "?" instead. That is only a
// guess about the currency, so it is OFF unless you opt in (see postProcessOcrText options).
const QUESTION_MARK_BEFORE_AMOUNT = /(^|\s)\?\s?(?=\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?(?!\d)|\d+\.\d{2}(?!\d))/g;

// ---------------------------------------------------------------- 3. digit confusions
const CONFUSABLE = { O: "0", o: "0", l: "1", I: "1", S: "5", B: "8" };
const swapConfusables = (text) => text.replace(/[OolISB]/g, (ch) => CONFUSABLE[ch]);

const CURRENCY_PREFIX = /^(?:us\$|[\u20B9$\u20AC\u00A3]|rs\.?|inr|usd|eur|gbp|aed)\s*/i;

const AMOUNT_SHAPES = [
    /^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/, // 1,234,567.89
    /^\d{1,3}(?:,\d{2})*,\d{3}(?:\.\d{1,2})?$/, // 1,18,000.00 (Indian grouping)
    /^\d+\.\d{1,2}$/, // 1200.50
    /^\d{1,3}(?:\.\d{3})+,\d{2}$/, // 1.234,56 (European)
];
const looksLikeAmount = (text) => AMOUNT_SHAPES.some((shape) => shape.test(text));

/**
 * Returns the corrected token, or null when it should be left alone.
 *
 * With a separator (1,2OO.OO / l,200.00): every character must be a digit, a separator or a
 * look-alike letter, and the corrected result must be a well-formed amount. A token that
 * STARTS with S or B is skipped: "S1,200.00" is far more likely "$1,200.00" than "51,200.00".
 *
 * Without a separator (1OO / 2O25): must start with a real digit and be at least 3
 * characters ("1O" alone could be anything, so it stays). Only O and l/I are swapped here,
 * never S or B, so codes like "B12" or "S10" are safe.
 */
const fixNumberToken = (core) => {
    if (!/\d/.test(core)) return null; // no real digit anywhere: this is a word, not a number

    if (/[.,]/.test(core)) {
        if (!/^[0-9OolISB.,]+$/.test(core) || /^[SB]/.test(core)) return null;
        const fixed = swapConfusables(core);
        return fixed !== core && looksLikeAmount(fixed) ? fixed : null;
    }

    if (core.length < 3 || !/^\d[0-9OolI]+$/.test(core)) return null;
    if (!/[OolI]/.test(core)) return null; // nothing to fix
    return core.replace(/[OolI]/g, (ch) => CONFUSABLE[ch]);
};

// ---------------------------------------------------------------- the public function
/**
 * postProcessOcrText(text, { questionMarkIsRupee }) -> { text, rawText, fixes, fixCount }
 *   text      cleaned text, for the parser
 *   rawText   exactly what OCR returned, for the review screen and for debugging
 *   fixes     [{ type, from, to, line }] (first 100 only); fixCount is the true total
 */
export const postProcessOcrText = (rawText, { questionMarkIsRupee = false } = {}) => {
    const fixes = [];
    let fixCount = 0;
    const record = (fix) => {
        fixCount++;
        if (fixes.length < MAX_RECORDED_FIXES) fixes.push(fix);
    };

    const lines = normalizeWhitespace(rawText).split("\n");

    const cleaned = lines.map((originalLine, index) => {
        const lineNumber = index + 1;
        let line = originalLine;

        for (const { pattern, to, name } of SYMBOL_FIXES) {
            line = line.replace(pattern, (match) => {
                record({ type: "currency-symbol", from: match, to, line: lineNumber, note: name });
                return to;
            });
        }
        if (questionMarkIsRupee) {
            line = line.replace(QUESTION_MARK_BEFORE_AMOUNT, (match, before) => {
                record({ type: "currency-symbol", from: "?", to: "\u20B9", line: lineNumber, note: "guessed from context" });
                return `${before}\u20B9`;
            });
        }

        // Token by token, so the spacing between tokens is preserved exactly
        return line.replace(/\S+/g, (token) => {
            const [, lead, body, trail] = token.match(/^([(\["']*)(.*?)([.,;:)\]"']*)$/);
            const prefix = body.match(CURRENCY_PREFIX)?.[0] ?? "";
            const core = body.slice(prefix.length);
            if (!core) return token;

            const fixed = fixNumberToken(core);
            if (fixed === null) return token;

            record({ type: "digit-confusion", from: core, to: fixed, line: lineNumber });
            return `${lead}${prefix}${fixed}${trail}`;
        });
    });

    return { text: cleaned.join("\n"), rawText: String(rawText ?? ""), fixes, fixCount };
};