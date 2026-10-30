/*
 * Label dictionary for the CORE invoice fields. Pure data: no logic lives here.
 * (Extra fields come from the FieldDefinition registry in the database.)
 *
 * HOW TO EXTEND: when an invoice is read wrongly or not at all, find the label it
 * prints next to the value and add it to the right list below. Nothing else changes.
 *
 * WRITING RULES: every label is written in NORMALIZED form, because the parser
 * normalizes the text it finds the same way before comparing:
 *   - lowercase
 *   - no punctuation  (write "invoice no", not "Invoice No.:")
 *   - "#" and "No." both become "no"  (write "invoice no" for "Invoice # / Invoice No.")
 *   - hyphens, underscores and slashes become spaces
 *   - single spaces only
 *
 * STRONG labels almost always mean this field. WEAK labels are often right but can
 * also mean something else, so the parser gives them lower confidence.
 * Within a list, EARLIER = HIGHER PRIORITY when a document contains several of them.
 */
export const LABELS = {
    invoiceNumber: {
        strong: [
            "invoice number", "invoice no", "invoice num", "invoice id",
            "tax invoice number", "tax invoice no", "inv no", "inv number",
            "bill number", "bill no",
        ],
        weak: [
            "reference", "reference no", "reference number", "ref no", "ref number",
            "document number", "document no", "doc no",
        ],
    },

    invoiceDate: {
        strong: [
            "invoice date", "date of invoice", "tax invoice date", "bill date",
            "billing date", "date of issue", "issue date",
        ],
        weak: ["date", "dated", "document date", "issued on"],
    },

    vendorName: {
        strong: [
            "vendor", "vendor name", "supplier", "supplier name", "name of supplier",
            "seller", "seller name", "sold by", "billed by", "issued by",
        ],
        // Many invoices print no vendor label at all: the parser also falls back to
        // the first meaningful line of the document (that is logic, so it lives in the parser).
        weak: ["from", "company", "company name", "business name", "payee"],
    },

    totalAmount: {
        // The total as printed, in priority order. "amount due" and "balance due" can be
        // lower than the invoice total when part has been paid, hence they come later.
        strong: [
            "grand total", "total amount", "invoice total", "invoice amount",
            "total invoice amount", "total invoice value", "total amount payable",
            "total payable", "net payable", "amount payable", "total due",
            "amount due", "balance due",
        ],
        // Exact label "total" only. "sub total" is a different label and must not match.
        // Do not add "amount": it is the name of a table column on almost every invoice.
        weak: ["total", "net total", "total price", "bill amount", "payable"],
    },

    currency: {
        strong: ["currency", "currency code", "currency type", "ccy"],
        weak: ["curr", "payment currency"],
    },
};

/*
 * Currency detection data (used by the normalizer when no "currency" label is found).
 * Symbols and words are matched in NORMALIZED form; codes are matched as written.
 * "$" is ambiguous (USD, CAD, AUD, SGD...): the normalizer should treat it as a weak
 * guess and prefer an explicit code when the document has one.
 */
export const CURRENCY_SYMBOLS = {
    "\u20B9": "INR", // rupee sign
    "rs": "INR",
    "inr": "INR",
    "$": "USD",
    "us$": "USD",
    "\u20AC": "EUR", // euro sign
    "\u00A3": "GBP", // pound sign
};

export const CURRENCY_CODES = [
    "INR", "USD", "EUR", "GBP", "AED", "SGD", "AUD", "CAD", "JPY", "CNY", "CHF", "NZD", "SAR", "ZAR",
];