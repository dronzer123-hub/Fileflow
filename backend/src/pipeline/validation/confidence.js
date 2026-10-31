// Turns per-field confidences, OCR quality and validation errors into ONE overall score,
// and decides whether a human should look at the result.

const REVIEW_THRESHOLD = Number(process.env.REVIEW_CONFIDENCE_THRESHOLD) || 0.7;
const FIELD_FLOOR = Number(process.env.FIELD_REVIEW_FLOOR) || 0.5;

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

/**
 * computeConfidence({ fieldConfidence, ocr, validationErrors })
 *   -> { confidence: 0..1, needsReview: boolean, reasons: string[] }
 */
export const computeConfidence = ({ fieldConfidence = {}, ocr = null, validationErrors = [] } = {}) => {
    const reasons = [];

    // 1. weighted average of the core fields
    let score = 0;
    for (const [field, weight] of Object.entries(WEIGHTS)) {
        score += weight * clamp01(fieldConfidence[field] ?? 0);
    }

    // 2. poor OCR drags everything down (0.9 OCR -> x0.95, 0.5 OCR -> x0.75)
    const ocrQuality = ocr ? normalizeOcr(ocr.averageConfidence) : null;
    if (ocrQuality !== null) {
        score *= 0.5 + 0.5 * ocrQuality;
        if (ocrQuality < 0.6) reasons.push(`Scanned text was hard to read (OCR confidence ${Math.round(ocrQuality * 100)}%).`);
    }

    // 3. every validation problem costs a little, up to a cap
    const penalty = Math.min(validationErrors.length * ERROR_PENALTY, MAX_ERROR_PENALTY);
    score -= penalty;

    const confidence = round2(clamp01(score));

    // 4. the review decision
    if (validationErrors.length > 0) reasons.push(`${validationErrors.length} validation problem(s) found.`);
    for (const field of CRITICAL) {
        const value = fieldConfidence[field];
        if (typeof value === "number" && value < FIELD_FLOOR) {
            reasons.push(`Low confidence in ${field} (${value}).`);
        }
    }
    if (confidence < REVIEW_THRESHOLD) reasons.push(`Overall confidence ${confidence} is below ${REVIEW_THRESHOLD}.`);

    return { confidence, needsReview: reasons.length > 0, reasons };
};