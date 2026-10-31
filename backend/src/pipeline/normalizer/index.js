import { createHash } from "node:crypto";
import { CURRENCY_CODES, CURRENCY_SYMBOLS } from "../parsers/labelDictionary.js";
import { normalizeLabel } from "../parsers/ruleBasedParser.js";


const DATE_ORDER = process.env.DATE_ORDER === "MDY" ? "MDY" : "DMY";
const AMBIGUOUS_DATE_PENALTY = 0.15;
const UNCONVERTED_EXTRA_PENALTY = 0.15;

const MAX_EXTRA_FIELDS = 50; // matches ExtractionResult
const MAX_LINE_ITEMS = 200;
const MAX_EXTRA_COLUMNS = 10;

// ---------------------------------------------------------------- text
const cleanText = (value) =>
    String(value ?? "")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/[\u0000-\u001F\u007F]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

const round = (n, places = 2) => {
    const f = 10 ** places;
    return Math.round((Number(n) + Number.EPSILON) * f) / f;
};
const clamp01 = (n) => round(Math.max(0, Math.min(1, n)));

// ---------------------------------------------------------------- amounts
// Converts ONE numeric token ("1,18,000.00", "1.234,56", "12,5") to a number, or null.
const parseNumberToken = (token) => {
    const text = token.replace(/[.,]+$/, "");
    if (!/\d/.test(text)) return null;

    const dots = (text.match(/\./g) ?? []).length;
    const commas = (text.match(/,/g) ?? []).length;
    let normalized;

    if (dots && commas) {
        const decimalSep = text.lastIndexOf(".") > text.lastIndexOf(",") ? "." : ",";
        const thousandsSep = decimalSep === "." ? "," : ".";
        normalized = text.split(thousandsSep).join("").replace(decimalSep, ".");
    } else if (commas) {
        const afterLast = text.length - text.lastIndexOf(",") - 1;
        normalized = commas > 1 || afterLast === 3 ? text.replace(/,/g, "") : text.replace(",", ".");
    } else if (dots > 1) {
        normalized = text.replace(/\./g, "");
    } else {
        normalized = text;
    }

    const number = Number(normalized);
    return Number.isFinite(number) ? number : null;
};

const NUMBER_TOKEN = /\d[\d.,]*/g;

// Picks a number out of text. "last" fixes values like "9%: 2,250.00" (the amount is last).
const parseNumber = (text, which = "last") => {
    const tokens = String(text ?? "").match(NUMBER_TOKEN);
    if (!tokens) return null;
    return parseNumberToken(which === "first" ? tokens[0] : tokens[tokens.length - 1]);
};

const parseMoney = (text) => {
    const number = parseNumber(text, "last");
    return number === null ? null : round(number, 2);
};

// ---------------------------------------------------------------- currency
const SYMBOLS_LONGEST_FIRST = Object.keys(CURRENCY_SYMBOLS).sort((a, b) => b.length - a.length);
const CODE_REGEX = new RegExp(`(?<![A-Za-z])(${CURRENCY_CODES.join("|")})(?![A-Za-z])`, "i");

export const detectCurrency = (text) => {
    const value = String(text ?? "");
    const code = value.match(CODE_REGEX);
    if (code) return code[1].toUpperCase();

    const lower = value.toLowerCase();
    for (const symbol of SYMBOLS_LONGEST_FIRST) {
        const found = /^[a-z]+$/.test(symbol)
            ? new RegExp(`(?<![a-z])${symbol}(?![a-z])`).test(lower) // "rs" must be a whole word
            : lower.includes(symbol);
        if (found) return CURRENCY_SYMBOLS[symbol];
    }
    return null;
};

// ---------------------------------------------------------------- dates
const MONTH_INDEX = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTHS =
    "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const ISO_LIKE = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/;
const NUMERIC = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/;
const DAY_MONTH_NAME = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s-]+(${MONTHS})\\.?,?[\\s-]+(\\d{2,4})\\b`, "i");
const MONTH_NAME_DAY = new RegExp(`\\b(${MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "i");

const fullYear = (text) => {
    const year = Number(text);
    if (text.length === 4) return year;
    return year <= 69 ? 2000 + year : 1900 + year;
};

// Builds a UTC date, or null when the day does not exist (31 Feb, month 13...)
const buildDate = (year, month, day) => {
    const date = new Date(Date.UTC(year, month - 1, day));
    const valid =
        date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    return valid ? date : null;
};

// Returns { date: Date, ambiguous: boolean } or null
export const parseDate = (text) => {
    const value = cleanText(text);
    let m;

    if ((m = value.match(ISO_LIKE))) {
        const date = buildDate(Number(m[1]), Number(m[2]), Number(m[3]));
        return date ? { date, ambiguous: false } : null;
    }
    if ((m = value.match(DAY_MONTH_NAME))) {
        const date = buildDate(fullYear(m[3]), MONTH_INDEX[m[2].slice(0, 3).toLowerCase()], Number(m[1]));
        return date ? { date, ambiguous: false } : null;
    }
    if ((m = value.match(MONTH_NAME_DAY))) {
        const date = buildDate(fullYear(m[3]), MONTH_INDEX[m[1].slice(0, 3).toLowerCase()], Number(m[2]));
        return date ? { date, ambiguous: false } : null;
    }
    if ((m = value.match(NUMERIC))) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        const year = fullYear(m[3]);

        let order;
        let ambiguous = false;
        if (a > 12 && b <= 12) order = "DMY";
        else if (b > 12 && a <= 12) order = "MDY";
        else if (a > 12 && b > 12) return null;
        else {
            order = DATE_ORDER;
            ambiguous = a !== b;
        }
        const date = order === "DMY" ? buildDate(year, b, a) : buildDate(year, a, b);
        return date ? { date, ambiguous } : null;
    }
    return null;
};

const toIsoDay = (date) => date.toISOString().slice(0, 10);

// ---------------------------------------------------------------- booleans
const TRUE_WORDS = new Set(["yes", "y", "true", "paid", "applicable", "1"]);
const FALSE_WORDS = new Set(["no", "n", "false", "unpaid", "not applicable", "na", "n a", "0"]);

const parseBoolean = (text) => {
    const word = normalizeLabel(text) || cleanText(text).toLowerCase();
    if (TRUE_WORDS.has(word)) return true;
    if (FALSE_WORDS.has(word)) return false;
    return null;
};

// ---------------------------------------------------------------- keys
// "GST No." -> "gst_no", "Ship-To / Dock" -> "ship_to_dock". Always matches ^[a-z][a-z0-9_]*$
export const makeSafeKey = (label, maxLength = 40) => {
    const ascii = cleanText(label)
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    if (ascii.length >= 2) {
        const safe = /^[a-z]/.test(ascii) ? ascii : `f_${ascii}`; // keys must start with a letter
        return safe.slice(0, maxLength).replace(/_+$/, "");
    }
    // Labels with no usable Latin letters (for example Hindi): stable hash-based key
    return `field_${createHash("sha1").update(cleanText(label).toLowerCase()).digest("hex").slice(0, 8)}`;
};

const camelKey = (label) => {
    const words = makeSafeKey(label, 30).split("_").filter(Boolean);
    return words.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join("");
};

// ---------------------------------------------------------------- core fields
const normalizeCore = (core = {}) => {
    const fields = {
        invoiceNumber: null, invoiceDate: null, vendorName: null, totalAmount: null, currency: null,
    };
    const fieldConfidence = {};
    const give = (name, value, confidence) => {
        fields[name] = value;
        fieldConfidence[name] = clamp01(confidence);
    };

    if (core.invoiceNumber) {
        const value = cleanText(core.invoiceNumber.raw).replace(/[.,;:]+$/, "");
        if (value && value.length <= 60) give("invoiceNumber", value, core.invoiceNumber.confidence);
    }

    if (core.vendorName) {
        const value = cleanText(core.vendorName.raw).slice(0, 200);
        if (value) give("vendorName", value, core.vendorName.confidence);
    }

    if (core.invoiceDate) {
        const parsed = parseDate(core.invoiceDate.raw);
        if (parsed) {
            give(
                "invoiceDate",
                parsed.date,
                core.invoiceDate.confidence - (parsed.ambiguous ? AMBIGUOUS_DATE_PENALTY : 0)
            );
        }
    }

    if (core.totalAmount) {
        const amount = parseMoney(core.totalAmount.raw);
        if (amount !== null) give("totalAmount", amount, core.totalAmount.confidence);
    }

    // Currency: an explicit currency field wins; otherwise read it from the total's own symbol/code
    const explicit = core.currency ? detectCurrency(core.currency.raw) : null;
    if (explicit) {
        give("currency", explicit, core.currency.confidence);
    } else if (core.totalAmount) {
        const fromTotal = detectCurrency(core.totalAmount.raw);
        if (fromTotal) give("currency", fromTotal, Math.min(core.totalAmount.confidence, 0.85));
    }

    return { fields, fieldConfidence };
};

// ---------------------------------------------------------------- extra fields
const convertByType = (dataType, text) => {
    switch (dataType) {
        case "number": {
            const n = parseNumber(text, "last");
            return n === null ? null : n;
        }
        case "currency": {
            const n = parseMoney(text);
            return n === null ? null : n;
        }
        case "date": {
            const parsed = parseDate(text);
            return parsed ? toIsoDay(parsed.date) : null;
        }
        case "boolean":
            return parseBoolean(text);
        default:
            return null;
    }
};

const normalizeExtras = (extras = [], registry = []) => {
    const definitions = new Map((registry ?? []).map((definition) => [definition.key, definition]));
    const usedKeys = new Set();
    const out = [];

    // Known keys first, so an unknown label can never steal a registry key
    const ordered = [...extras].sort((a, b) => Number(Boolean(definitions.has(b.key))) - Number(Boolean(definitions.has(a.key))));

    for (const extra of ordered) {
        if (out.length >= MAX_EXTRA_FIELDS) break;

        const label = cleanText(extra.label).slice(0, 100);
        const value = cleanText(extra.rawValue).slice(0, 500);
        if (!label || !value) continue;

        const definition = extra.key ? definitions.get(extra.key) : null;
        let confidence = extra.confidence ?? 0.4;

        if (definition) {
            if (usedKeys.has(definition.key)) continue;
            usedKeys.add(definition.key);

            const dataType = definition.dataType ?? "text";
            let parsedValue = null;
            let valueType = "text";
            if (dataType !== "text") {
                parsedValue = convertByType(dataType, value);
                if (parsedValue === null) confidence -= UNCONVERTED_EXTRA_PENALTY; // could not read it as that type
                else valueType = dataType;
            }
            out.push({
                key: definition.key, label, value, parsedValue, valueType,
                confidence: clamp01(confidence), isKnown: true,
            });
            continue;
        }

        // Unknown label: safe key, text value
        const base = makeSafeKey(label);
        let key = base;
        for (let n = 2; usedKeys.has(key); n++) {
            const suffix = `_${n}`;
            key = `${base.slice(0, 40 - suffix.length)}${suffix}`;
        }
        usedKeys.add(key);
        out.push({
            key, label, value, parsedValue: null, valueType: "text",
            confidence: clamp01(confidence), isKnown: false,
        });
    }
    return out;
};

// ---------------------------------------------------------------- line items
// Column headers are matched through normalizeLabel, same as everywhere else
const COLUMN_ALIASES = {
    description: ["description", "item", "item description", "particulars", "product", "details", "name", "goods"],
    quantity: ["qty", "quantity", "nos", "units", "no of units"],
    unitPrice: ["rate", "unit price", "price", "unit cost", "unit rate", "price per unit"],
    amount: ["amount", "total", "line total", "value", "net amount", "ext price", "amount inr"],
};
const COLUMN_LOOKUP = new Map(
    Object.entries(COLUMN_ALIASES).flatMap(([canonical, names]) => names.map((n) => [normalizeLabel(n), canonical]))
);

const normalizeLineItems = (rows = []) => {
    const items = [];

    for (const row of rows) {
        if (items.length >= MAX_LINE_ITEMS) break;
        const item = {};
        const extraColumns = {};

        for (const [column, rawCell] of Object.entries(row ?? {})) {
            const cell = cleanText(rawCell);
            if (!cell) continue;

            const canonical = COLUMN_LOOKUP.get(normalizeLabel(column)) ?? (column in COLUMN_ALIASES ? column : null);
            if (canonical === "description") {
                item.description = cell.slice(0, 300);
            } else if (canonical === "quantity") {
                const n = parseNumber(cell, "first");
                if (n !== null) item.quantity = n;
            } else if (canonical === "unitPrice" || canonical === "amount") {
                const n = parseMoney(cell);
                if (n !== null) item[canonical] = n;
            } else if (Object.keys(extraColumns).length < MAX_EXTRA_COLUMNS) {
                const key = camelKey(column);
                if (!key) continue;
                // Identifiers such as "HSN Code 0847" stay text so leading zeros survive
                const isIdentifier = /\b(?:code|no|number|id|hsn|sac|sku)\b/i.test(column);
                const isNumeric = !isIdentifier && /^[^\p{L}]*\d[\d.,]*\s*%?$/u.test(cell);
                extraColumns[key] = isNumeric ? parseNumber(cell, "last") : cell.slice(0, 100);
            }
        }

        if (Object.keys(extraColumns).length) item.extraColumns = extraColumns;
        if (item.description || item.quantity != null || item.amount != null) items.push(item);
    }
    return items;
};


export const normalizeInvoice = ({ parsed, registry = [] }) => {
    const { fields, fieldConfidence } = normalizeCore(parsed?.core);
    return {
        fields,
        fieldConfidence,
        extraFields: normalizeExtras(parsed?.extras, registry),
        lineItems: normalizeLineItems(parsed?.lineItems),
    };
};