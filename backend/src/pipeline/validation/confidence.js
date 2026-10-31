// Turns per-field confidences, OCR quality and validation errors into ONE overall score,
// and decides whether a human should look at the result.

const REVIEW_THRESHOLD = Number(process.env.REVIEW_CONFIDENCE_THRESHOLD) || 0.7;
const FIELD_FLOOR = Number(process.env.FIELD_REVIEW_FLOOR) || 0.5;

// The same OCR floor that config/ocr.js reads. Read here directly (not imported) so this file
// stays usable by the API and in unit tests, where config/ocr.js would throw without language data.
// Accepts 0..1 or 0..100, like the OCR config.
const readOcrFloor = () => {
    const value = Number(process.env.OCR_CONFIDENCE_FLOOR);
    if (!Number.isFinite(value) || value <= 0) return 0.6;
    return value > 1 ? value / 100 : value;
};
const OCR_FLOOR = readOcrFloor();

// How much each core field counts. They add up to 1. A missing field contributes 0.
const WEIGHTS = {
    totalAmount: 0.35,
    invoiceNumber: 0.3,
    invoiceDate: 0.2,
    vendorName: 0.1,
    currency: 0.05,
};

// These must be trustworthy on their own: one shaky value is a reason to look,
// even when the weighted average hides it. (vendorName is excluded: a first-line
// guess is normally low and is not worth a review by itself.)
const CRITICAL = ["invoiceNumber", "invoiceDate", "totalAmount"];

const ERROR_PENALTY = 0.1;
const MAX_ERROR_PENALTY = 0.3;

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const round2 = (n) => Math.round(n * 100) / 100;

// Tesseract reports 0..100, our stored value is 0..1; accept either
const normalizeOcr = (value) => (typeof value !== "number" || Number.isNaN(value) ? null : clamp01(value > 1 ? value / 100 : value));

// ---------------------------------------------------------------- which page did a field come from?
/**
 * Maps each core field to the page its value was found on.
 *   core   parsed.core: each found field has a 1-based `line` in the full text
 *   pages  extracted.pages: one string per page; the full text is pages.join("\n\n")
 * Returns { invoiceNumber: 2, totalAmount: 2, ... }. Fields without a line are left out.
 * currency has no line of its own: it is read from the total, so it takes the total's page.
 */
export const fieldPagesFromLines = ({ core = {}, pages = [] }) => {
    // First line (1-based) of every page inside the joined text. Joining with "\n\n" leaves one blank line between pages.
    const starts = [];
    let next = 1;
    for (const page of pages) {
        starts.push(next);
        next += String(page ?? "").split("\n").length + 1;
    }

    const pageOfLine = (line) => {
        let found = 0;
        for (let i = 0; i < starts.length; i++) if (line >= starts[i]) found = i;
        return found + 1; // pages are numbered from 1
    };

    const result = {};
    for (const [field, value] of Object.entries(core)) {
        if (Number.isInteger(value?.line) && value.line > 0) result[field] = pageOfLine(value.line);
    }
    if (!result.currency && result.totalAmount) result.currency = result.totalAmount;
    return result;
};

/**
 * computeConfidence({ fieldConfidence, ocr, fieldPages, validationErrors })
 *   -> { confidence: 0..1, needsReview: boolean, reasons: string[], fieldConfidence }
 *
 *   ocr          extracted.ocr (with averageConfidence, confidencePerPage, lowConfidencePages) or null
 *   fieldPages   from fieldPagesFromLines; when missing, a field is scaled by the overall OCR average
 *   fieldConfidence in the result is the SCALED version: store this one.
 */
export const computeConfidence = ({ fieldConfidence = {}, ocr = null, fieldPages = {}, validationErrors = [] } = {}) => {
    const reasons = [];

    // 1. OCR quality scales each field by the quality of ITS OWN page
    //    (0.9 OCR -> x0.95, 0.5 OCR -> x0.75). A field from an embedded-text page is not scaled.
    const overallOcr = ocr ? normalizeOcr(ocr.averageConfidence) : null;
    const pageQuality = new Map((ocr?.confidencePerPage ?? []).map((page) => [page.pageNumber, normalizeOcr(page.confidence)]));

    const scaled = {};
    for (const [field, value] of Object.entries(fieldConfidence)) {
        if (typeof value !== "number") continue;
        let quality = null; // null = no OCR involved for this field
        if (ocr) {
            const page = fieldPages[field];
            if (page === undefined) quality = overallOcr; // we do not know the page: use the average
            else if (pageQuality.has(page)) quality = pageQuality.get(page); // this page was OCR'd
        }
        scaled[field] = quality === null ? value : round2(value * (0.5 + 0.5 * quality));
    }

    // 2. weighted average of the (scaled) core fields
    let score = 0;
    for (const [field, weight] of Object.entries(WEIGHTS)) {
        score += weight * clamp01(scaled[field] ?? 0);
    }

    // 3. every validation problem costs a little, up to a cap
    score -= Math.min(validationErrors.length * ERROR_PENALTY, MAX_ERROR_PENALTY);
    const confidence = round2(clamp01(score));

    // 4. the review decision
    if (validationErrors.length > 0) reasons.push(`${validationErrors.length} validation problem(s) found.`);

    // The floor you tune from your own invoices: poor OCR means review, even if every field was found
    if (overallOcr !== null && overallOcr < OCR_FLOOR) {
        reasons.push(`Scanned text was hard to read (OCR confidence ${Math.round(overallOcr * 100)}%, floor ${Math.round(OCR_FLOOR * 100)}%).`);
    }

    const weakPages = new Set(ocr?.lowConfidencePages ?? []);
    for (const field of CRITICAL) {
        const value = scaled[field];
        if (typeof value !== "number") continue;
        if (value < FIELD_FLOOR) reasons.push(`Low confidence in ${field} (${value}).`);
        else if (weakPages.has(fieldPages[field])) reasons.push(`${field} was read from a low-quality scan (page ${fieldPages[field]}).`);
    }

    if (confidence < REVIEW_THRESHOLD) reasons.push(`Overall confidence ${confidence} is below ${REVIEW_THRESHOLD}.`);

    return { confidence, needsReview: reasons.length > 0, reasons, fieldConfidence: scaled };
};