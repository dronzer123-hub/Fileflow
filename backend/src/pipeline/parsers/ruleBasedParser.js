import { LABELS, CURRENCY_CODES, CURRENCY_SYMBOLS } from "./labelDictionary.js";

const MAX_LABEL_WORDS = 6;
const MAX_EXTRAS = 30; // the ExtractionResult model allows 50; stay well under it
const MAX_VALUE_CHARS = 300;
const COLUMN_GAP = /\s{2,}|\t|\|/;

// ---------------------------------------------------------------- label normalization
// The ONE normalizing function. Everything compared with the dictionary or the registry
// goes through it: lowercase, letters only, "#" and "No." both become "no".
const WORD_REGEX = /\p{L}+|[#№]/gu;
const toWord = (token) => (token === "#" || token === "№" ? "no" : token.toLowerCase());

export const normalizeLabel = (text) =>
    [...String(text ?? "").matchAll(WORD_REGEX)].map((m) => toWord(m[0])).join(" ");

const tokenize = (line) =>
    [...line.matchAll(WORD_REGEX)].map((m) => ({
        word: toWord(m[0]),
        start: m.index,
        end: m.index + m[0].length,
    }));

// ---------------------------------------------------------------- value patterns
const MONTHS =
    "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const DATE_PATTERN = [
    "\\b\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}\\b", // 2024-03-12
    "\\b\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}\\b", // 12/03/2024, 12-03-24
    `\\b\\d{1,2}(?:st|nd|rd|th)?[\\s-]+(?:${MONTHS})\\.?,?[\\s-]+\\d{2,4}\\b`, // 12 March 2024, 05-Jan-2024
    `\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, // March 12, 2024
].join("|");
const DATE_REGEX = new RegExp(DATE_PATTERN, "i");
const DATE_WHOLE = new RegExp(`^(?:${DATE_PATTERN})$`, "i");

const CURRENCY_PREFIX = "(?:\\u20B9|rs\\.?|inr|usd|eur|gbp|aed|us\\$|\\$|\\u20AC|\\u00A3)";
const AMOUNT_PATTERN = `(?:${CURRENCY_PREFIX}\\s*)?(?:\\d{1,3}(?:\\.\\d{3})+,\\d{2}|\\d[\\d,]*(?:\\.\\d+)?)(?:\\s*(?:inr|usd|eur|gbp|aed))?`;
const AMOUNT_REGEX = new RegExp(AMOUNT_PATTERN, "i");
const AMOUNT_WHOLE = new RegExp(`^${AMOUNT_PATTERN}$`, "i");

const ID_TOKEN_REGEX = /[A-Za-z0-9#][A-Za-z0-9\-/_.]*[A-Za-z0-9]|[A-Za-z0-9]/;

// Rough number for COMPARING candidates only; the normalizer does the real parsing
const amountToNumber = (raw) => {
    const digits = String(raw).replace(/[^\d.,]/g, "");
    if (!digits) return NaN;
    const lastDot = digits.lastIndexOf(".");
    const lastComma = digits.lastIndexOf(",");
    let normalized;
    if (lastDot > -1 && lastComma > -1) {
        normalized = lastDot > lastComma
            ? digits.replace(/,/g, "")
            : digits.replace(/\./g, "").replace(",", ".");
    } else if (lastComma > -1) {
        normalized = /,\d{1,2}$/.test(digits) ? digits.replace(",", ".") : digits.replace(/,/g, "");
    } else {
        normalized = (digits.match(/\./g) ?? []).length > 1 ? digits.replace(/\./g, "") : digits;
    }
    return Number(normalized);
};

// Each validator returns the cleaned raw value, or null when the text does not look right.
// This is what stops a sentence like "date of delivery is soon" becoming an invoice date.
const VALIDATORS = {
    invoiceNumber: (value) => {
        const match = value.match(ID_TOKEN_REGEX);
        if (!match) return null;
        const token = match[0].replace(/^#/, "");
        if (!/\d/.test(token) || token.length > 40 || DATE_WHOLE.test(token)) return null;
        return token;
    },
    invoiceDate: (value) => value.match(DATE_REGEX)?.[0] ?? null,
    totalAmount: (value) => {
        const match = value.match(AMOUNT_REGEX);
        if (!match) return null;
        const raw = match[0].trim();
        const digitCount = (raw.match(/\d/g) ?? []).length;
        if (digitCount === 0 || digitCount > 15) return null;
        if (value[match.index + match[0].length] === "%") return null; // a percentage, not money
        return raw;
    },
    currency: (value) => {
        const code = value.match(new RegExp(`\\b(${CURRENCY_CODES.join("|")})\\b`, "i"));
        if (code) return code[1].toUpperCase();
        const lower = value.toLowerCase();
        return Object.keys(CURRENCY_SYMBOLS).find((symbol) => lower.includes(symbol)) ?? null;
    },
    vendorName: (value) => {
        const text = value.split(COLUMN_GAP)[0].replace(/[\s,;:.\-–]+$/, "").trim();
        if (text.length < 2 || text.length > 100) return null;
        if ((text.match(/\p{L}/gu) ?? []).length < 2) return null;
        if (DATE_WHOLE.test(text) || AMOUNT_WHOLE.test(text)) return null;
        return text;
    },
};

// ---------------------------------------------------------------- label index
const buildLabelIndex = (registry) => {
    const index = new Map();

    for (const [field, groups] of Object.entries(LABELS)) {
        for (const strength of ["strong", "weak"]) {
            groups[strength].forEach((label, priority) => {
                const key = normalizeLabel(label);
                if (key && !index.has(key)) index.set(key, { type: "core", field, strength, priority });
            });
        }
    }
    // Registry (extra fields). Core labels always win a collision.
    for (const definition of registry ?? []) {
        for (const synonym of [...(definition.synonyms ?? []), definition.displayLabel]) {
            const key = normalizeLabel(synonym);
            if (key && !index.has(key)) index.set(key, { type: "extra", key: definition.key, definition });
        }
    }
    return index;
};

// ---------------------------------------------------------------- finding labels in a line
// A label counts only at the start of a line, after a column gap, or in "Label:" form.
// This keeps "Please pay the total within 30 days" from being read as a total.
const isLabelBoundary = (line, start, end) => {
    const before = line.slice(0, start);
    if (/^[^\p{L}\p{N}]{0,3}$/u.test(before)) return true;
    if (/(?:\s{2,}|\t|\|)$/.test(before)) return true;
    if (/^\s*:/.test(line.slice(end))) return !/\p{L}\s+$/u.test(before); // "Sub Total:" must not become "Total:"
    return false;
};

const findHits = (line, index, maxWords) => {
    const tokens = tokenize(line);
    const hits = [];
    let i = 0;
    while (i < tokens.length) {
        let found = null;
        for (let length = Math.min(maxWords, tokens.length - i); length >= 1; length--) {
            const key = tokens.slice(i, i + length).map((t) => t.word).join(" ");
            const entry = index.get(key);
            if (entry) {
                found = { entry, length, start: tokens[i].start, end: tokens[i + length - 1].end };
                break;
            }
        }
        if (found && isLabelBoundary(line, found.start, found.end)) {
            const rest = line.slice(found.end);
            const separators = rest.match(/^(?:\s|:|\||=|\.(?!\d)|[-–—](?=\s))*/)[0].length;
            hits.push({
                ...found,
                printedLabel: line.slice(found.start, found.end).trim(),
                valueStart: found.end + separators,
            });
            i += found.length;
        } else {
            i += 1;
        }
    }
    return hits;
};

const cleanValue = (text) =>
    (text ?? "").split(COLUMN_GAP)[0].replace(/[\s,;:|]+$/, "").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- confidence
const baseConfidence = (strength, source) =>
    strength === "strong" ? (source === "same-line" ? 0.9 : 0.8) : source === "same-line" ? 0.6 : 0.5;

const round = (n) => Math.round(Math.max(0, Math.min(1, n)) * 100) / 100;

// ---------------------------------------------------------------- choosing between candidates
const pickBest = (field, candidates) => {
    if (candidates.length === 0) return null;

    const rank = (c) => (c.strength === "strong" ? 0 : 1);
    const sorted = [...candidates].sort((a, b) => {
        const byLabel = rank(a) - rank(b) || a.priority - b.priority;
        if (byLabel) return byLabel;
        if (field === "totalAmount") {
            // Same label several times (for example "Total" on each page): the largest amount, then the latest
            return amountToNumber(b.raw) - amountToNumber(a.raw) || b.line - a.line;
        }
        return a.line - b.line;
    });

    const best = sorted[0];
    // Same label with a different value elsewhere means the document is ambiguous
    const conflicting = sorted.some(
        (c) => c !== best && c.labelKey === best.labelKey && c.raw.toLowerCase() !== best.raw.toLowerCase()
    );

    return {
        raw: best.raw,
        confidence: round(baseConfidence(best.strength, best.source) - (conflicting ? 0.1 : 0)),
        line: best.line,
        label: best.label,
        source: best.source,
    };
};

// ---------------------------------------------------------------- vendor fallback
const TITLE_LINES = new Set([
    "invoice", "tax invoice", "gst invoice", "proforma invoice", "bill", "receipt", "cash memo",
    "credit note", "original", "duplicate", "original for recipient", "duplicate for transporter",
]);

const guessVendorFromTopLines = (lines, hitsByLine) => {
    let seen = 0;
    for (let i = 0; i < lines.length && seen < 12; i++) {
        const text = lines[i];
        if (!text) continue;
        seen++;
        if (hitsByLine[i].length > 0) continue;
        if (text.length < 3 || text.length > 80) continue;
        if (text.split(/\s+/).length > 8 || /[.!?]$/.test(text)) continue; // a sentence, not a company name
        if (/@|https?:|www\.|\d{5,}/i.test(text)) continue;
        if (TITLE_LINES.has(normalizeLabel(text))) continue;
        if ((text.match(/\p{L}/gu) ?? []).length < 3) continue;
        if (DATE_REGEX.test(text) || AMOUNT_WHOLE.test(text)) continue;
        return { raw: text, confidence: 0.35, line: i + 1, label: null, source: "first-line-guess" };
    }
    return null;
};

// ---------------------------------------------------------------- the parser
/**
 * Returns { parserUsed, core, extras, lineItems }
 *   core   - only the fields that were found: { raw, confidence, line, label, source }
 *   extras - [{ label, rawValue, confidence, key?, line }]   (key is set when the registry knows it)
 *   lineItems - always [] for now (table parsing is a later stretch goal)
 */
export const parseWithRules = ({ text, registry = [] }) => {
    const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim());
    const index = buildLabelIndex(registry);
    const maxWords = Math.min(
        MAX_LABEL_WORDS,
        Math.max(...[...index.keys()].map((key) => key.split(" ").length))
    );
    const hitsByLine = lines.map((line) => (line ? findHits(line, index, maxWords) : []));

    const nextNonEmpty = (from) => {
        for (let i = from + 1; i <= Math.min(from + 2, lines.length - 1); i++) if (lines[i]) return i;
        return -1;
    };

    const candidates = Object.fromEntries(Object.keys(LABELS).map((field) => [field, []]));
    const knownExtras = new Map(); // registry key -> extra (first one wins)

    const record = (hit, value, source, lineIndex) => {
        const entry = hit.entry;
        if (!value) return;

        if (entry.type === "core") {
            const raw = VALIDATORS[entry.field](value);
            if (raw) {
                candidates[entry.field].push({
                    raw, strength: entry.strength, priority: entry.priority, source,
                    line: lineIndex + 1, label: hit.printedLabel, labelKey: normalizeLabel(hit.printedLabel),
                });
            }
        } else if (!knownExtras.has(entry.key)) {
            knownExtras.set(entry.key, {
                label: hit.printedLabel,
                rawValue: value.slice(0, MAX_VALUE_CHARS),
                confidence: source === "same-line" ? 0.85 : 0.7,
                key: entry.key,
                line: lineIndex + 1,
            });
        }
    };

    lines.forEach((line, li) => {
        const hits = hitsByLine[li];
        if (hits.length === 0) return;

        // Values on the same line: from the end of a label up to the start of the next label
        hits.forEach((hit, hi) => {
            const stop = hits[hi + 1]?.start ?? line.length;
            hit.value = cleanValue(line.slice(hit.valueStart, Math.max(stop, hit.valueStart)));
        });

        const allEmpty = hits.every((hit) => !hit.value);

        // A header row of labels with the values on the next line, in the same order
        if (hits.length >= 2 && allEmpty) {
            const next = nextNonEmpty(li);
            if (next !== -1 && hitsByLine[next].length === 0) {
                const cells = lines[next].split(COLUMN_GAP).map((c) => c.trim()).filter(Boolean);
                if (cells.length === hits.length) hits.forEach((hit, hi) => (hit.value = cells[hi]));
                hits.forEach((hit) => record(hit, hit.value, "column", li));
            }
            return;
        }

        hits.forEach((hit, hi) => {
            if (hit.value) return record(hit, hit.value, "same-line", li);

            // Only the last label on a line can continue on the next line
            if (hi !== hits.length - 1) return;
            const next = nextNonEmpty(li);
            if (next === -1) return;
            const nextHits = hitsByLine[next];
            if (nextHits.length > 0 && nextHits[0].start <= 3) return; // the next line is another label

            // Addresses run over several lines
            if (hit.entry.type === "extra" && /address/.test(hit.entry.key)) {
                const block = [];
                for (let i = next; i < lines.length && block.length < 4 && lines[i] && hitsByLine[i].length === 0; i++) {
                    block.push(lines[i]);
                }
                return record(hit, block.join(", "), "next-line", li);
            }
            const stop = nextHits[0]?.start ?? lines[next].length;
            record(hit, cleanValue(lines[next].slice(0, stop)), "next-line", li);
        });
    });

    // Core fields: nothing is returned for a field that was not found
    const core = {};
    for (const field of Object.keys(LABELS)) {
        const best = pickBest(field, candidates[field]);
        if (best) core[field] = best;
    }
    if (!core.vendorName) {
        const guess = guessVendorFromTopLines(lines, hitsByLine);
        if (guess) core.vendorName = guess;
    }

    // Extras: known ones first, then unknown "Label: value" pairs
    const extras = [...knownExtras.values()];
    const seenUnknown = new Set();

    lines.forEach((line, li) => {
        if (!line || extras.length >= MAX_EXTRAS) return;
        for (const segment of line.split(COLUMN_GAP)) {
            const colon = segment.indexOf(":");
            if (colon < 1) continue;

            const label = segment.slice(0, colon).trim();
            const value = segment.slice(colon + 1).trim();
            const wordCount = label.split(/\s+/).length;

            if (!/^\p{L}/u.test(label) || /\d/.test(label) || label.length > 40 || wordCount > 5) continue;
            if (/^(?:https?|ftp|mailto)$/i.test(label) || value.startsWith("//")) continue;
            if (!value || value.length > 60) continue;
            if (index.has(normalizeLabel(label))) continue; // already handled as a known label

            const key = `${normalizeLabel(label)}=${value.toLowerCase()}`;
            if (seenUnknown.has(key)) continue;
            seenUnknown.add(key);
            extras.push({ label, rawValue: value, confidence: 0.4, line: li + 1 });
            if (extras.length >= MAX_EXTRAS) break;
        }
    });

    return { parserUsed: "rule-based", core, extras: extras.slice(0, MAX_EXTRAS), lineItems: [] };
};