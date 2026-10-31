import { z } from "zod";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { getFieldRegistry } from "../pipeline/fieldRegistry.js";
import { convertByType } from "../pipeline/normalizer/index.js"; // the SAME conversion rules the pipeline uses

// Limits (the ExtractionResult model and the validator use the same numbers)
const MAX_EXTRA_CHANGES = 50; // entries to set, and entries to remove, per request
const MAX_KEY_LENGTH = 40;
const MAX_LABEL_LENGTH = 100;
const MAX_VALUE_LENGTH = 500;
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

// A key must not look like a core field once underscores are ignored ("invoice_number" is out)
const CORE_FIELD_NAMES = ["invoicenumber", "invoicedate", "vendorname", "totalamount", "currency"];

// ---------------------------------------------------------------- building blocks
const tidy = (text) => text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

// Trims, collapses whitespace, then checks the length
const text = (name, max) =>
    z.unknown().transform((value, ctx) => {
        if (typeof value !== "string") {
            ctx.addIssue({ code: "custom", message: `${name} must be text.` });
            return z.NEVER;
        }
        const cleaned = tidy(value);
        if (!cleaned) {
            ctx.addIssue({ code: "custom", message: `${name} cannot be empty.` });
            return z.NEVER;
        }
        if (cleaned.length > max) {
            ctx.addIssue({ code: "custom", message: `${name} cannot be longer than ${max} characters.` });
            return z.NEVER;
        }
        return cleaned;
    });

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// ---------------------------------------------------------------- core fields
// Every field is optional: send only what changed. Core fields cannot be cleared (a completed
// invoice needs them); to leave one alone, leave it out.
const coreFieldsSchema = z
    .object({
        invoiceNumber: text("Invoice number", 60),

        // The date input of the review form sends YYYY-MM-DD. Stored as midnight UTC, like the normalizer does.
        invoiceDate: z
            .string()
            .trim()
            .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date format YYYY-MM-DD.")
            .transform((value, ctx) => {
                const date = new Date(`${value}T00:00:00.000Z`);
                if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
                    ctx.addIssue({ code: "custom", message: "That date does not exist." });
                    return z.NEVER;
                }
                const year = date.getUTCFullYear();
                if (year < 1990 || year > 2100) {
                    ctx.addIssue({ code: "custom", message: "The year must be between 1990 and 2100." });
                    return z.NEVER;
                }
                return date;
            }),

        vendorName: text("Vendor name", 200),

        // A number, or a plain decimal string such as "1200.50". Never a string like "1,200" (ambiguous).
        totalAmount: z.unknown().transform((value, ctx) => {
            const number =
                typeof value === "number"
                    ? value
                    : typeof value === "string" && /^\d+(\.\d{1,2})?$/.test(value.trim())
                      ? Number(value)
                      : NaN;
            if (!Number.isFinite(number)) {
                ctx.addIssue({ code: "custom", message: "Total amount must be a number such as 1200.50 (no commas)." });
                return z.NEVER;
            }
            if (number <= 0) {
                ctx.addIssue({ code: "custom", message: "Total amount must be greater than zero." });
                return z.NEVER;
            }
            if (number > 1e12) {
                ctx.addIssue({ code: "custom", message: "Total amount is too large." });
                return z.NEVER;
            }
            return round2(number);
        }),

        currency: z
            .string()
            .trim()
            .transform((value) => value.toUpperCase())
            .pipe(z.string().regex(/^[A-Z]{3}$/, "Currency must be a 3-letter code such as INR.")),
    })
    .partial()
    .strict(); // anything else (status, confidence, owner...) is rejected, not silently ignored

// ---------------------------------------------------------------- extra fields
const keySchema = z
    .string()
    .trim()
    .min(1, "Key cannot be empty.")
    .max(MAX_KEY_LENGTH, `Key cannot be longer than ${MAX_KEY_LENGTH} characters.`)
    .regex(KEY_PATTERN, "Key must start with a lowercase letter and use only lowercase letters, digits and underscores.")
    .refine((key) => !CORE_FIELD_NAMES.includes(key.replace(/_/g, "")), "That key is reserved for a main invoice field.");

// Numbers and booleans from a form are fine; they become text like every other value
const valueSchema = z.preprocess(
    (value) => (typeof value === "number" || typeof value === "boolean" ? String(value) : value),
    text("Value", MAX_VALUE_LENGTH)
);

const extraSetSchema = z
    .object({
        key: keySchema,
        label: text("Label", MAX_LABEL_LENGTH).optional(), // known keys use the registry's label when this is left out
        value: valueSchema,
    })
    .strict();

const extraFieldsSchema = z
    .object({
        set: z.array(extraSetSchema).max(MAX_EXTRA_CHANGES, `You can change at most ${MAX_EXTRA_CHANGES} extra fields at once.`).default([]),
        remove: z.array(keySchema).max(MAX_EXTRA_CHANGES, `You can remove at most ${MAX_EXTRA_CHANGES} extra fields at once.`).default([]),
    })
    .strict()
    .default({ set: [], remove: [] });

// ---------------------------------------------------------------- the whole request
/**
 * Body of the review request:
 *   {
 *     fields:      { invoiceNumber?, invoiceDate?, vendorName?, totalAmount?, currency? },
 *     extraFields: { set: [{ key, label?, value }], remove: ["key", ...] }
 *   }
 * `set` adds or edits (the service tells which by whether the key exists); `remove` deletes.
 *
 * The registry is needed to check typed values, so the schema is built per request.
 */
export const makeReviewSchema = (registry = []) => {
    const definitions = new Map((registry ?? []).map((definition) => [definition.key, definition]));

    return z
        .object({
            fields: coreFieldsSchema.default({}),
            extraFields: extraFieldsSchema,
        })
        .strict()
        .superRefine((body, ctx) => {
            const { set, remove } = body.extraFields;

            // Something must actually change
            if (Object.keys(body.fields).length === 0 && set.length === 0 && remove.length === 0) {
                ctx.addIssue({ code: "custom", path: [], message: "Nothing to update: send at least one changed field." });
            }

            // The same key twice, or set and removed at once, is ambiguous: refuse instead of guessing
            const seen = new Set();
            set.forEach(({ key }, index) => {
                if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["extraFields", "set", index, "key"], message: `"${key}" appears more than once.` });
                seen.add(key);
            });
            remove.forEach((key, index) => {
                if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["extraFields", "remove", index], message: `"${key}" cannot be both set and removed, or listed twice.` });
                seen.add(key);
            });

            // A key the registry knows must hold a value of its declared type
            set.forEach(({ key, value }, index) => {
                const definition = definitions.get(key);
                if (!definition || !definition.dataType || definition.dataType === "text") return;
                if (convertByType(definition.dataType, value) === null) {
                    ctx.addIssue({
                        code: "custom",
                        path: ["extraFields", "set", index, "value"],
                        message: `"${definition.displayLabel ?? key}" must be a valid ${definition.dataType}.`,
                    });
                }
            });
        });
};

// ---------------------------------------------------------------- middleware
// Same behaviour as validate(): bad input -> 400 with field-level details,
// good input -> req.validated.body (and req.body) hold the cleaned values.
export const validateReviewBody = asyncHandler(async (req, res, next) => {
    const registry = await getFieldRegistry(); // cached for a few minutes
    const result = makeReviewSchema(registry).safeParse(req.body ?? {});

    if (!result.success) {
        const details = result.error.issues.map((issue) => ({
            field: issue.path.join(".") || "body",
            message: issue.message,
        }));
        return next(ApiError.badRequest("Validation failed.", details));
    }

    req.validated = { ...req.validated, body: result.data };
    req.body = result.data;
    next();
});