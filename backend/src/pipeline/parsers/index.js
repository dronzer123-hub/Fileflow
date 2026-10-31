import { parseWithTemplate } from "./templateParsers/index.js";
import { normalizeLabel, parseWithRules } from "./ruleBasedParser.js";

const MAX_EXTRAS = 30;
const CORE_FIELDS = ["vendorName", "invoiceNumber", "invoiceDate", "totalAmount"];


const AI_PARSER_ENABLED = process.env.AI_PARSER_ENABLED === "true";

// eslint-disable-next-line no-unused-vars
const parseWithAi = async ({ text, registry, partial }) => null;

const shouldTryAi = (merged) =>
    AI_PARSER_ENABLED && CORE_FIELDS.some((field) => !merged.core[field] || merged.core[field].confidence < 0.5);

// ---------------------------------------------------------------- merging
// Primary wins every conflict; secondary only fills gaps.
const mergeResults = (primary, secondary) => {
    const core = { ...secondary.core };
    for (const [field, value] of Object.entries(primary.core)) core[field] = value;

    const extras = [...primary.extras];
    const knownKeys = new Set(extras.filter((e) => e.key).map((e) => e.key));
    const seenLabels = new Set(extras.map((e) => normalizeLabel(e.label)));

    for (const extra of secondary.extras) {
        if (extras.length >= MAX_EXTRAS) break;
        if (extra.key ? knownKeys.has(extra.key) : seenLabels.has(normalizeLabel(extra.label))) continue;
        extras.push(extra);
    }

    return {
        parserUsed: primary.parserUsed,
        core,
        extras,
        lineItems: primary.lineItems.length ? primary.lineItems : secondary.lineItems,
    };
};



export const parseInvoice = async ({ text, registry = [] }) => {
    const rules = parseWithRules({ text, registry });
    const template = parseWithTemplate({ text, registry }); // null when none matched or it failed

    let result = template ? mergeResults(template, rules) : rules;

    if (shouldTryAi(result)) {
        try {
            const ai = await parseWithAi({ text, registry, partial: result });
            if (ai) {
                // Existing results win; AI only fills gaps, and is labelled as such
                result = mergeResults(result, { ...ai, extras: ai.extras ?? [], lineItems: ai.lineItems ?? [] });
                result.parserUsed = `${result.parserUsed}+ai`;
            }
        } catch {
            // The AI step is optional: any failure leaves the rule-based result untouched
        }
    }

    return result;
};