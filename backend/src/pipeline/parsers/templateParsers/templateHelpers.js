// Small helpers so every template returns fields in the same shape as ruleBasedParser.js
export const TEMPLATE_CONFIDENCE = 0.95; // layout-specific rules are more trustworthy than generic ones

export const toLines = (text) => String(text ?? "").split(/\r?\n/).map((line) => line.trim());

// First line matching `regex`. Returns { raw, line } where raw is capture group 1 (or the whole match)
export const matchLine = (lines, regex) => {
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(regex);
        if (m) return { raw: (m[1] ?? m[0]).trim(), line: i + 1 };
    }
    return null;
};

// Builds one core-field object, or undefined when nothing was found (so the field is simply absent)
export const makeField = (found, label = null, confidence = TEMPLATE_CONFIDENCE) =>
    found ? { raw: found.raw, confidence, line: found.line, label, source: "template" } : undefined;

// Drops undefined fields so "not found" stays "absent"
export const compactCore = (core) =>
    Object.fromEntries(Object.entries(core).filter(([, value]) => value));

// Case/space-insensitive "does the text contain this?" (OCR often changes spacing)
export const containsLoose = (text, needle) =>
    String(text ?? "").toLowerCase().replace(/\s+/g, "").includes(needle.toLowerCase().replace(/\s+/g, ""));