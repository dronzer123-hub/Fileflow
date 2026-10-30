import fs from "fs/promises";
import { PDFParse, PasswordException, InvalidPDFException, FormatError } from "pdf-parse";
import { PermanentJobError } from "../../utils/jobErrors.js";

/**
 * Reads the embedded text of a PDF, one string per page.
 * Returns { pages: [string, ...], pageCount }. A page with no text gives "".
 */
export const extractPdfText = async (filePath) => {
    const data = await fs.readFile(filePath);
    const parser = new PDFParse({ data });

    try {
        const result = await parser.getText();

        if (!result.total) {
            throw new PermanentJobError("This PDF has no pages.");
        }

        const textByPage = new Map(result.pages.map((page) => [page.num, page.text ?? ""]));
        const pages = Array.from({ length: result.total }, (_, index) =>
            (textByPage.get(index + 1) ?? "").trim()
        );

        return { pages, pageCount: result.total };
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
        await parser.destroy(); // always free the memory the parser holds
    }
};