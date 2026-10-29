import fs from "fs/promises";
import { fileTypeFromFile } from "file-type";
import { ApiError } from "./ApiError.js";

// What the client claimed (from Multer) -> our category
const CATEGORY_BY_DECLARED_MIME = {
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpeg",
    "text/csv": "csv",
    "application/vnd.ms-excel": "csv",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

// What the file's first bytes say it really is -> our category
const CATEGORY_BY_REAL_MIME = {
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpeg",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

// The one mime type we store for each category
const CANONICAL_MIME = {
    pdf: "application/pdf",
    png: "image/png",
    jpeg: "image/jpeg",
    csv: "text/csv",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const SAMPLE_BYTES = 8192;

const removeFile = async (filePath) => {
    try {
        await fs.unlink(filePath);
    } catch {
        // already gone: nothing to do
    }
};

// CSV has no magic bytes, so check that the start of the file looks like text:
// no zero bytes and almost no control characters.
const looksLikeText = async (filePath) => {
    const handle = await fs.open(filePath, "r");
    try {
        const { bytesRead, buffer } = await handle.read(Buffer.alloc(SAMPLE_BYTES), 0, SAMPLE_BYTES, 0);
        if (bytesRead === 0) return false;

        const sample = buffer.subarray(0, bytesRead);
        if (sample.includes(0)) return false;

        let controlCharacters = 0;
        for (const byte of sample) {
            if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) controlCharacters++;
        }
        return controlCharacters / bytesRead < 0.01;
    } finally {
        await handle.close();
    }
};

/**
 * Checks what the saved file really is.
 * Returns { category, mimeType } when it is allowed and matches what was declared.
 * Otherwise deletes the file and throws a 400 ApiError.
 */
export const verifyUploadedFile = async (file) => {
    try {
        const declared = CATEGORY_BY_DECLARED_MIME[file.mimetype];

        const detected = await fileTypeFromFile(file.path);
        const actual = detected
            ? CATEGORY_BY_REAL_MIME[detected.mime] // a recognised binary format, or undefined if not allowed
            : (await looksLikeText(file.path)) ? "csv" : undefined;

        if (!declared || !actual || declared !== actual) {
            await removeFile(file.path);
            throw ApiError.badRequest(
                "The file content does not match an allowed type. Upload a real PDF, PNG, JPEG, CSV or XLSX file."
            );
        }

        return { category: actual, mimeType: CANONICAL_MIME[actual] };
    } catch (error) {
        // Unexpected failure (for example the file could not be read): clean up, then rethrow
        await removeFile(file.path);
        throw error;
    }
};