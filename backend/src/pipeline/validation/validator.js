// Decides whether an extraction result can be trusted.
// Returns an array of readable messages. An empty array means "no problems found".
// The caller (processor) turns a non-empty list into the needs_review status.

const MAX_INVOICE_NUMBER_LENGTH = 60;
const MAX_TOTAL = 1e12;
const MAX_FUTURE_DAYS = 30; // invoices are sometimes post-dated a little
const MAX_AGE_YEARS = 10;

const MAX_EXTRA_FIELDS = 50;
const MAX_KEY_LENGTH = 40;
const MAX_LABEL_LENGTH = 100;
const MAX_VALUE_LENGTH = 500;
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

const SUM_TOLERANCE_ABS = 1; // one currency unit...
const SUM_TOLERANCE_REL = 0.005; // ...or 0.5% of the total, whichever is larger

const CORE_FIELD_NAMES = ["invoicenumber", "invoicedate", "vendorname", "totalamount", "currency"];

const DAY_MS = 24 * 60 * 60 * 1000;
const isPresent = (value) => value !== null && value !== undefined && value !== "";
const money = (n) => (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });

// ---------------------------------------------------------------- core fields
const checkRequired = ({ invoiceNumber, invoiceDate, totalAmount }, errors) => {
    if (!isPresent(invoiceNumber)) errors.push("Invoice number is missing.");
    if (!isPresent(invoiceDate)) errors.push("Invoice date is missing.");
    if (!isPresent(totalAmount)) errors.push("Total amount is missing.");
};

const checkSanity = ({ invoiceNumber, invoiceDate, totalAmount }, errors, now) => {
    if (isPresent(invoiceNumber)) {
        const length = String(invoiceNumber).length;
        if (length > MAX_INVOICE_NUMBER_LENGTH) {
            errors.push(`Invoice number is unusually long (${length} characters).`);
        }
    }

    if (isPresent(totalAmount)) {
        if (typeof totalAmount !== "number" || !Number.isFinite(totalAmount)) {
            errors.push("Total amount is not a valid number.");
        } else if (totalAmount <= 0) {
            errors.push(`Total amount must be greater than zero (found ${totalAmount}).`);
        } else if (totalAmount > MAX_TOTAL) {
            errors.push(`Total amount looks implausibly large (${totalAmount}).`);
        }
    }

    if (isPresent(invoiceDate)) {
        const time = invoiceDate instanceof Date ? invoiceDate.getTime() : NaN;
        if (Number.isNaN(time)) {
            errors.push("Invoice date is not a valid date.");
        } else {
            const maxDate = now + MAX_FUTURE_DAYS * DAY_MS;
            const minDate = new Date(now).setUTCFullYear(new Date(now).getUTCFullYear() - MAX_AGE_YEARS);
            const shown = new Date(time).toISOString().slice(0, 10);
            if (time > maxDate) errors.push(`Invoice date ${shown} is in the future.`);
            else if (time < minDate) errors.push(`Invoice date ${shown} is more than ${MAX_AGE_YEARS} years old.`);
        }
    }
};

// ---------------------------------------------------------------- line items
// Item totals often exclude tax, so a plain "sum equals total" check would raise false alarms.
// We accept: sum == total, or sum + the invoice's known tax extras == total.
const checkLineItemSum = ({ totalAmount }, lineItems, extraFields, registry, errors) => {
    if (!Array.isArray(lineItems) || lineItems.length === 0) return;
    if (typeof totalAmount !== "number" || !(totalAmount > 0)) return;
    if (lineItems.some((item) => typeof item.amount !== "number")) return; // a partial sum proves nothing

    const sum = lineItems.reduce((acc, item) => acc + item.amount, 0);
    const tolerance = Math.max(SUM_TOLERANCE_ABS, totalAmount * SUM_TOLERANCE_REL);
    if (Math.abs(sum - totalAmount) <= tolerance) return;

    const taxKeys = new Set(
        (registry ?? []).filter((definition) => definition.category === "tax").map((definition) => definition.key)
    );
    const tax = (extraFields ?? [])
        .filter((extra) => taxKeys.has(extra.key) && typeof extra.parsedValue === "number")
        .reduce((acc, extra) => acc + extra.parsedValue, 0);
    if (tax > 0 && Math.abs(sum + tax - totalAmount) <= tolerance) return;

    errors.push(
        `Line items add up to ${money(sum)} but the total is ${money(totalAmount)}` +
            (tax > 0 ? ` (still different after adding ${money(tax)} of tax).` : ".")
    );
};

// ---------------------------------------------------------------- extra fields
const checkExtras = (extraFields, registry, errors) => {
    if (!Array.isArray(extraFields) || extraFields.length === 0) return;

    if (extraFields.length > MAX_EXTRA_FIELDS) {
        errors.push(`Too many extra fields (${extraFields.length}; the limit is ${MAX_EXTRA_FIELDS}).`);
    }

    const definitions = new Map((registry ?? []).map((definition) => [definition.key, definition]));
    const seen = new Set();

    for (const extra of extraFields) {
        const name = extra.label || extra.key || "(unnamed)";

        if (!extra.key || !KEY_PATTERN.test(extra.key) || extra.key.length > MAX_KEY_LENGTH) {
            errors.push(`Extra field "${name}" has an invalid key.`);
            continue;
        }
        if (CORE_FIELD_NAMES.includes(extra.key.replace(/_/g, ""))) {
            errors.push(`Extra field "${name}" uses the reserved name "${extra.key}".`);
        }
        if (seen.has(extra.key)) errors.push(`Extra field key "${extra.key}" appears more than once.`);
        seen.add(extra.key);

        if ((extra.label ?? "").length > MAX_LABEL_LENGTH) errors.push(`The label of extra field "${extra.key}" is too long.`);
        if (!extra.value) errors.push(`Extra field "${name}" has no value.`);
        else if (extra.value.length > MAX_VALUE_LENGTH) errors.push(`The value of extra field "${name}" is too long.`);

        // Only known fields have a declared type to check against
        if (extra.isKnown) {
            const declared = definitions.get(extra.key)?.dataType ?? extra.valueType ?? "text";
            if (declared !== "text" && (extra.parsedValue === null || extra.parsedValue === undefined)) {
                errors.push(`"${name}" should be a ${declared} but "${extra.value}" could not be read as one.`);
            }
        }
    }
};

// ---------------------------------------------------------------- entry point
/**
 * validateInvoice({ fields, lineItems, extraFields, registry? }) -> string[]
 *   registry is optional; with it the validator can check declared types and tax extras.
 *   now is injectable so tests do not depend on today's date.
 */
export const validateInvoice = ({ fields = {}, lineItems = [], extraFields = [], registry = [], now = Date.now() }) => {
    const errors = [];
    checkRequired(fields, errors);
    checkSanity(fields, errors, now);
    checkLineItemSum(fields, lineItems, extraFields, registry, errors);
    checkExtras(extraFields, registry, errors);
    return errors;
};