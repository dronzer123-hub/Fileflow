import { getFilePath } from "../services/storage.service.js";
import { recordEvent } from "../services/event.service.js";
import { PermanentJobError } from "../utils/jobErrors.js";
import { getFieldRegistry } from "./fieldRegistry.js";
import { extractContent } from "./extractors/index.js";
import { parseInvoice } from "./parsers/index.js";
import { normalizeInvoice } from "./normalizer/index.js";
import { validateInvoice } from "./validation/validator.js";
import { computeConfidence } from "./validation/confidence.js";

const CORE_FIELDS = ["invoiceNumber", "invoiceDate", "vendorName", "totalAmount", "currency"];
const MIN_TEXT_CHARS = 20; // less than this means nothing readable was found
const MAX_LABELS_IN_EVENT = 20;

// Runs a step and also returns how long it took
const timed = async (step) => {
    const start = Date.now();
    const value = await step();
    return [value, Date.now() - start];
};

export const handleInvoice = async ({ job, log }) => {
    // With local storage this is the stored file. (With cloud storage this becomes a
    // temporary downloaded copy; see the storage notes.)
    const filePath = await getFilePath(job.storagePath);
    const registry = await getFieldRegistry();

    // Stage 1: get text out of the file (PDF text, or OCR for scans and photos)
    const [extracted, extractMs] = await timed(() =>
        extractContent({ filePath, mimeType: job.mimeType, log })
    );

    const text = extracted.text ?? "";
    if (text.trim().length < MIN_TEXT_CHARS) {
        throw new PermanentJobError("No readable text was found in this file.");
    }

    await recordEvent(job._id, "text_extracted", "Text extracted from the file.", {
        method: extracted.method,
        characters: text.length,
        pages: extracted.pageCount,
        durationMs: extractMs,
        warnings: extracted.warnings,
    });

    if (extracted.ocr) {
        await recordEvent(job._id, "ocr_used", "OCR was used to read the file.", {
            pages: extracted.ocr.pagesProcessed,
            averageConfidence: extracted.ocr.averageConfidence,
            language: extracted.ocr.language,
            durationMs: extracted.ocr.durationMs,
            preprocessing: extracted.ocr.preprocessing,
        });
    }

    // Stages 2 and 3: find the fields, then convert them into one common structure
    const [parsed, parseMs] = await timed(async () => parseInvoice({ text, registry }));
    const normalized = normalizeInvoice({ parsed, registry });

    const foundCore = CORE_FIELDS.filter((key) => normalized.fields[key] != null);
    const unknownLabels = normalized.extraFields
        .filter((extra) => !extra.isKnown)
        .map((extra) => extra.label)
        .slice(0, MAX_LABELS_IN_EVENT);

    await recordEvent(job._id, "fields_extracted", "Fields identified and normalized.", {
        parser: parsed.parserUsed,
        coreFieldsFound: foundCore,
        coreFieldsMissing: CORE_FIELDS.filter((key) => !foundCore.includes(key)),
        extraFields: normalized.extraFields.length,
        unknownLabels, // the labels that keep appearing are the ones to add to the registry
        lineItems: normalized.lineItems.length,
        durationMs: parseMs,
    });

    // Stages 4 and 5: check the result and decide how far it can be trusted.
    // (The processor records the final completed / needs-review event.)
    const validationErrors = validateInvoice({
        fields: normalized.fields,
        lineItems: normalized.lineItems,
        extraFields: normalized.extraFields,
    });

    const { confidence, needsReview } = computeConfidence({
        fieldConfidence: normalized.fieldConfidence,
        ocr: extracted.ocr,
        validationErrors,
    });

    log.debug({ confidence, needsReview, errors: validationErrors.length }, "Invoice stages finished");

    return {
        ...normalized.fields, // invoiceNumber, invoiceDate, vendorName, totalAmount, currency
        extraFields: normalized.extraFields,
        lineItems: normalized.lineItems,
        extractionMethod: extracted.method,
        parserUsed: parsed.parserUsed,
        confidence,
        fieldConfidence: normalized.fieldConfidence,
        rawText: text,
        ocrInfo: extracted.ocr
            ? {
                  pagesProcessed: extracted.ocr.pagesProcessed,
                  averageConfidence: extracted.ocr.averageConfidence,
                  language: extracted.ocr.language,
                  durationMs: extracted.ocr.durationMs,
              }
            : undefined,
        validationErrors,
        needsReview,
    };
};