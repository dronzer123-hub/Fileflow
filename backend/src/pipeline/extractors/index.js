import { PermanentJobError } from "../../utils/jobErrors.js";
import { extractPdfText } from "./pdfTextExtractor.js";
import { extractWithOcr } from "./ocrExtractor.js";
import { extractCsv } from "./csvExtractor.js";

// A page with fewer non-space characters than this is treated as scanned
const MIN_TEXT_CHARS_PER_PAGE = Number(process.env.MIN_TEXT_CHARS_PER_PAGE) || 50;
// An OCR result below this average confidence gets a warning (the review decision is made later)
const LOW_OCR_CONFIDENCE = 0.6;

const IMAGE_TYPES = ["image/png", "image/jpeg"];

const countChars = (text) => (text ?? "").replace(/\s+/g, "").length;

const ocrInfoFrom = (ocr) => ({
    pagesProcessed: ocr.pagesProcessed,
    averageConfidence: ocr.averageConfidence,
    language: ocr.language,
    durationMs: ocr.durationMs,
    preprocessing: ocr.preprocessing,
});

const lowConfidenceWarning = (ocr) =>
    ocr.averageConfidence < LOW_OCR_CONFIDENCE
        ? [`OCR confidence is low (${Math.round(ocr.averageConfidence * 100)}%). Check the extracted values.`]
        : [];

// PDFs: use the embedded text where there is any, OCR only the pages that have none
const extractPdf = async ({ filePath, log }) => {
    const { pages, pageCount } = await extractPdfText(filePath);

    const scannedPages = [];
    pages.forEach((pageText, index) => {
        if (countChars(pageText) < MIN_TEXT_CHARS_PER_PAGE) scannedPages.push(index + 1);
    });

    // Every page has real text: no OCR needed
    if (scannedPages.length === 0) {
        return {
            text: pages.join("\n\n"),
            pages,
            method: "text",
            pageCount,
            warnings: [],
        };
    }

    log.info({ scannedPages, pageCount }, "Some pages have no embedded text: using OCR for them");
    const ocr = await extractWithOcr({ filePath, kind: "pdf", pageNumbers: scannedPages, log });

    const ocrTextByPage = new Map(ocr.pages.map((page) => [page.pageNumber, page.text ?? ""]));
    const combined = pages.map((pageText, index) =>
        scannedPages.includes(index + 1) ? ocrTextByPage.get(index + 1) ?? "" : pageText
    );

    const warnings = [
        `Page${scannedPages.length > 1 ? "s" : ""} ${scannedPages.join(", ")} had no embedded text and ${scannedPages.length > 1 ? "were" : "was"} read with OCR.`,
        ...lowConfidenceWarning(ocr),
    ];

    return {
        text: combined.join("\n\n"),
        pages: combined,
        method: scannedPages.length === pageCount ? "ocr" : "hybrid",
        pageCount,
        warnings,
        ocr: ocrInfoFrom(ocr),
    };
};

// Photos and screenshots: straight to OCR
const extractImage = async ({ filePath, log }) => {
    const ocr = await extractWithOcr({ filePath, kind: "image", log });
    const text = ocr.pages[0]?.text ?? "";

    return {
        text,
        pages: [text],
        method: "ocr",
        pageCount: 1,
        warnings: lowConfidenceWarning(ocr),
        ocr: ocrInfoFrom(ocr),
    };
};

const extractCsvFile = async ({ filePath }) => {
    const { text, headers, rows, truncated } = await extractCsv(filePath);

    return {
        text,
        pages: [text],
        method: "text",
        pageCount: 1,
        warnings: truncated ? [`The file is large: only the first ${rows.length} rows were read.`] : [],
        table: { headers, rows },
    };
};

/**
 * Looks at the real file type and returns:
 *   { text, pages, method: "text" | "ocr" | "hybrid", pageCount, warnings, ocr?, table? }
 */
export const extractContent = async ({ filePath, mimeType, log }) => {
    if (mimeType === "application/pdf") return extractPdf({ filePath, log });
    if (IMAGE_TYPES.includes(mimeType)) return extractImage({ filePath, log });
    if (mimeType === "text/csv") return extractCsvFile({ filePath });

    // .xlsx files are accepted at upload but not supported by any extractor yet
    throw new PermanentJobError("This file type cannot be processed yet.");
};