import { ocrConfig } from "../../config/ocr.js";
import { logger } from "../../utils/logger.js";
import { withTempDir } from "../../utils/tempFiles.js";
import { preprocessImage } from "../ocr/imagePreprocessor.js";
import { recognizeImage } from "../ocr/ocrEngine.js";
import { postProcessOcrText } from "../ocr/ocrPostProcessor.js";
import { renderPdfToImages } from "../ocr/pdfToImages.js";

const round3 = (n) => Math.round(n * 1000) / 1000;
const pageSeparator = (pageNumber, total) => `\n\n-- page ${pageNumber} of ${total} --\n\n`;

// OCR one page image: preprocess -> recognize -> clean up the text
const readPage = async ({ imagePath, pageNumber, dir, attempt }) => {
    const prepared = await preprocessImage({ inputPath: imagePath, outputDir: dir, name: `page-${String(pageNumber).padStart(3, "0")}` });
    const recognized = await recognizeImage({ imagePath: prepared.path, attempt });
    const cleaned = postProcessOcrText(recognized.text);

    return {
        pageNumber,
        text: cleaned.text,
        rawText: cleaned.rawText,
        confidence: recognized.confidence, // 0..1
        wordCount: recognized.words.length,
        fixCount: cleaned.fixCount,
        steps: prepared.steps,
        durationMs: recognized.durationMs,
    };
};

/**
 * extractWithOcr({ filePath, kind, pageNumbers, jobId, attempt, log })
 *   kind         "pdf" or "image"
 *   pageNumbers  (pdf only) the 1-based pages to read; default: all of them
 *   jobId        names the temp folder
 *   attempt      the job's attempt number; a page that times out on a retry is a permanent failure
 *
 * Returns
 *   { text,                    all pages joined, with "-- page N of M --" between them
 *     pages,                   [{ pageNumber, text, rawText, confidence, wordCount, ... }]
 *     pagesProcessed, averageConfidence,   (0..1, weighted by words per page)
 *     confidencePerPage,       [{ pageNumber, confidence, words }]
 *     lowConfidencePages,      [pageNumber] below OCR_CONFIDENCE_FLOOR
 *     language, durationMs, preprocessing,  (list of steps applied)
 *     fixCount, warnings }
 * The temp folder is always removed, whatever happens.
 */
export const extractWithOcr = async ({ filePath, kind, pageNumbers, jobId, attempt = 1, log = logger }) => {
    const startedAt = Date.now();

    const pages = await withTempDir(jobId ?? "job", async (dir) => {
        if (kind === "image") {
            return [await readPage({ imagePath: filePath, pageNumber: 1, dir, attempt })];
        }

        if (kind !== "pdf") throw new Error(`extractWithOcr: unknown kind "${kind}"`);

        const { images, pageCount } = await renderPdfToImages({
            pdfPath: filePath,
            outputDir: dir,
            maxPages: ocrConfig.maxPages,
            scale: ocrConfig.renderScale,
            pageNumbers,
        });
        log.info({ rendered: images.length, pageCount }, "PDF pages rendered for OCR");

        // One page at a time: bounded memory, and a failure names the page
        const results = [];
        for (const image of images) {
            results.push(await readPage({ imagePath: image.path, pageNumber: image.pageNumber, dir, attempt }));
        }
        return results;
    });

    // ---- combine
    const totalWords = pages.reduce((sum, page) => sum + page.wordCount, 0);
    const averageConfidence = totalWords
        ? round3(pages.reduce((sum, page) => sum + page.confidence * page.wordCount, 0) / totalWords)
        : 0;

    const lowConfidencePages = pages
        .filter((page) => page.wordCount === 0 || page.confidence < ocrConfig.confidenceFloor)
        .map((page) => page.pageNumber);

    const warnings = [];
    const blank = pages.filter((page) => page.wordCount === 0).map((page) => page.pageNumber);
    if (blank.length) warnings.push(`OCR found no text on page${blank.length > 1 ? "s" : ""} ${blank.join(", ")}.`);
    const weak = lowConfidencePages.filter((number) => !blank.includes(number));
    if (weak.length) {
        warnings.push(`OCR confidence is below ${Math.round(ocrConfig.confidenceFloor * 100)}% on page${weak.length > 1 ? "s" : ""} ${weak.join(", ")}.`);
    }

    const text = pages.map((page, index) => (index === 0 ? "" : pageSeparator(page.pageNumber, pages.length)) + page.text).join("");

    return {
        text,
        pages,
        pagesProcessed: pages.length,
        averageConfidence,
        confidencePerPage: pages.map((page) => ({ pageNumber: page.pageNumber, confidence: page.confidence, words: page.wordCount })),
        lowConfidencePages,
        language: ocrConfig.languageString,
        durationMs: Date.now() - startedAt,
        preprocessing: [...new Set(pages.flatMap((page) => page.steps))],
        fixCount: pages.reduce((sum, page) => sum + page.fixCount, 0),
        warnings,
    };
};