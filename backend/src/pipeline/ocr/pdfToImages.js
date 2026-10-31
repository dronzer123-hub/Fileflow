import fs from "node:fs/promises";
import path from "node:path";
import { PDFParse, PasswordException, InvalidPDFException, FormatError } from "pdf-parse";
import { PermanentJobError } from "../../utils/jobErrors.js";

const pageFileName = (pageNumber) => `page-${String(pageNumber).padStart(3, "0")}.png`;


export const renderPdfToImages = async ({ pdfPath, outputDir, maxPages, scale, pageNumbers }) => {
    const data = await fs.readFile(pdfPath);
    const parser = new PDFParse({ data });

    try {
        // Reading the page count first catches encrypted/corrupt files before any rendering work
        const { total: pageCount } = await parser.getInfo();
        if (!pageCount) throw new PermanentJobError("This PDF has no pages.");

        const wanted = pageNumbers?.length
            ? [...new Set(pageNumbers)].filter((n) => Number.isInteger(n) && n >= 1 && n <= pageCount).sort((a, b) => a - b)
            : Array.from({ length: pageCount }, (_, index) => index + 1);

        if (wanted.length === 0) throw new PermanentJobError("None of the requested pages exist in this PDF.");
        if (wanted.length > maxPages) {
            throw new PermanentJobError(
                `This PDF needs OCR on ${wanted.length} pages, but the limit is ${maxPages}. Split it into smaller files and upload them again.`
            );
        }

        const images = [];
        for (const pageNumber of wanted) {
            // One page per call: only one PNG is in memory at any time
            const shot = await parser.getScreenshot({
                partial: [pageNumber],
                scale,
                imageBuffer: true,
                imageDataUrl: false, // the base64 copy would double the memory for nothing
            });
            const page = shot.pages[0];
            if (!page?.data?.length) {
                throw new Error(`Rendering page ${pageNumber} produced no image.`); // unexpected: temporary
            }

            const filePath = path.join(outputDir, pageFileName(pageNumber));
            await fs.writeFile(filePath, page.data);
            images.push({ pageNumber, path: filePath });
        }

        return { images, pageCount };
    } catch (error) {
        if (error instanceof PermanentJobError) throw error;

        if (error instanceof PasswordException) {
            throw new PermanentJobError("This PDF is password-protected. Remove the password and upload it again.");
        }
        if (error instanceof InvalidPDFException || error instanceof FormatError) {
            throw new PermanentJobError("This file is damaged or is not a valid PDF.");
        }
        throw error; // anything else is unexpected: let the processor treat it as temporary
    } finally {
        await parser.destroy();
    }
};