import { logger } from "../../../utils/logger.js";
// import acmeOfficeSupplies from "./acmeOfficeSupplies.js";   // register real templates here

// Order matters: the first template whose detect() returns true is used.
const TEMPLATES = [
    // acmeOfficeSupplies,
];

/**
 * Returns the matching template's result, or null when no template applies
 * (or the template failed). null always means "fall back to the generic parser".
 *   result = { parserUsed: "template:<id>", core, extras, lineItems }
 */
export const parseWithTemplate = ({ text, registry }) => {
    for (const template of TEMPLATES) {
        let matched = false;
        try {
            matched = template.detect(text);
        } catch (err) {
            logger.warn({ err, template: template.id }, "template detect() threw; skipping it");
        }
        if (!matched) continue;

        try {
            const result = template.extract({ text, registry });
            return {
                parserUsed: `template:${template.id}`,
                core: result.core ?? {},
                extras: result.extras ?? [],
                lineItems: result.lineItems ?? [],
            };
        } catch (err) {
            // A broken template must never fail the job
            logger.error({ err, template: template.id }, "template extract() threw; falling back to generic parser");
            return null;
        }
    }
    return null;
};

export const listTemplateIds = () => TEMPLATES.map((t) => t.id);