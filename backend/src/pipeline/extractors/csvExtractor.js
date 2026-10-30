import fs from "fs/promises";
import { parse, CsvError } from "csv-parse/sync";
import { PermanentJobError } from "../../utils/jobErrors.js";

const MAX_ROWS = Number(process.env.CSV_MAX_ROWS) || 5000; // protects memory in the first version
const DELIMITERS = [",", ";", "\t", "|"];

// UTF-8 first; if the bytes are not valid UTF-8 (typical of "CSV" saved by older Excel
// versions), read it as Windows-1252 so accented characters survive.
const decode = (buffer) => {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
        return new TextDecoder("windows-1252").decode(buffer);
    }
};

// Picks the separator that appears most often in the first line
const detectDelimiter = (text) => {
    const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
    let best = ",";
    let bestCount = 0;
    for (const delimiter of DELIMITERS) {
        const count = firstLine.split(delimiter).length - 1;
        if (count > bestCount) {
            best = delimiter;
            bestCount = count;
        }
    }
    return best;
};

// Header names must be unique and non-empty, or rows lose columns
const cleanHeaders = (rawHeaders) => {
    const seen = new Map();
    return rawHeaders.map((raw, index) => {
        const base = String(raw ?? "").trim() || `column_${index + 1}`;
        const count = (seen.get(base) ?? 0) + 1;
        seen.set(base, count);
        return count === 1 ? base : `${base}_${count}`;
    });
};

/**
 * Reads a CSV file. Returns { text, headers, rows, truncated }:
 *   headers   - the column names
 *   rows      - an array of objects keyed by header, at most CSV_MAX_ROWS of them
 *   truncated - true when the file had more rows than were read
 *   text      - a plain-text rendering (headers, then one line per row)
 */
export const extractCsv = async (filePath) => {
    const buffer = await fs.readFile(filePath);
    const content = decode(buffer).replace(/^\uFEFF/, ""); // drop a byte-order mark if present

    if (content.trim() === "") {
        throw new PermanentJobError("This CSV file is empty.");
    }

    let headers = [];
    let records;
    try {
        records = parse(content, {
            delimiter: detectDelimiter(content),
            columns: (rawHeaders) => {
                headers = cleanHeaders(rawHeaders);
                return headers;
            },
            skip_empty_lines: true,
            trim: true,
            relax_column_count: true, // ragged rows are common in hand-made files
            relax_quotes: true,
            to: MAX_ROWS + 1, // read one extra row, only to learn whether the file was cut short
        });
    } catch (error) {
        if (error instanceof CsvError) {
            throw new PermanentJobError("This CSV file could not be read. Check that it is a valid CSV file.");
        }
        throw error;
    }

    const truncated = records.length > MAX_ROWS;
    const rows = truncated ? records.slice(0, MAX_ROWS) : records;

    if (rows.length === 0) {
        throw new PermanentJobError("This CSV file has a header but no data rows.");
    }

    const lines = [
        headers.join(" | "),
        ...rows.map((row) => headers.map((header) => row[header] ?? "").join(" | ")),
    ];

    return { text: lines.join("\n"), headers, rows, truncated };
};