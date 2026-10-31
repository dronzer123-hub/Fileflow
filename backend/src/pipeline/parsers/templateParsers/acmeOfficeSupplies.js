import { compactCore, containsLoose, makeField, matchLine, toLines } from "./templateHelpers.js";

export default {
    id: "acme-office-supplies",
    name: "Acme Office Supplies Pvt Ltd",

    // Cheap and strict. A tax id is the best signal; a company name is the fallback.
    detect: (text) =>
        /27ABCDE1234F1Z5/i.test(text) || containsLoose(text, "Acme Office Supplies"),

    extract: ({ text }) => {
        const lines = toLines(text);

        const core = compactCore({
            vendorName: { raw: "Acme Office Supplies Pvt Ltd", confidence: 0.95, line: 1, label: null, source: "template" },
            invoiceNumber: makeField(matchLine(lines, /^Inv\.?\s*No\.?\s*:\s*([A-Z0-9/\-]+)/i), "Inv No"),
            invoiceDate: makeField(matchLine(lines, /^Date\s*:\s*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/i), "Date"),
            totalAmount: makeField(matchLine(lines, /^Net\s+Payable\s*[:\-]?\s*((?:₹|Rs\.?)?\s*[\d,]+\.\d{2})/i), "Net Payable"),
        });

        const extras = [];
        const po = matchLine(lines, /^PO\s*Ref\s*:\s*(\S+)/i);
        if (po) extras.push({ label: "PO Ref", rawValue: po.raw, confidence: 0.9, key: "po_number", line: po.line });

        return { core, extras, lineItems: [] };
    },
};