import { PermanentJobError } from "../../utils/jobErrors.js";

/**
 * STUB: real OCR is built in Phase 9.
 *
 * The final version must keep this signature and return:
 *   {
 *     pages: [{ pageNumber, text, confidence }],  // confidence 0..1
 *     pagesProcessed,
 *     averageConfidence,                          // 0..1
 *     language,
 *     durationMs,
 *     preprocessing: [stepName, ...],
 *   }
 *
 *   kind        - "pdf" or "image"
 *   pageNumbers - for a PDF, the 1-based pages to read (the others already have text)
 */
export const extractWithOcr = async ({ filePath, kind, pageNumbers, log }) => {
    log?.warn({ kind, pageNumbers }, "OCR requested but not implemented yet");

    // Permanent: retrying cannot make OCR appear, so fail the job right away with a clear message
    throw new PermanentJobError("Scanned files and photos cannot be processed yet.");
};