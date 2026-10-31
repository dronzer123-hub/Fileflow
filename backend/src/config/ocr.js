import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// IMPORTANT: import this file only from the WORKER side (the OCR extractor).
// It throws at import time when the language data is missing, and the API server
// does not need OCR, so it must never import it.

const SERVER_ROOT = fileURLToPath(new URL("../../", import.meta.url)); // .../server/

const env = process.env;

const readNumber = (name, fallback, { min = 0, max = Infinity, integer = false } = {}) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    const valid = Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
    if (!valid) {
        throw new Error(
            `Invalid ${name}="${raw}": expected ${integer ? "an integer" : "a number"} between ${min} and ${max}.`
        );
    }
    return value;
};

const readFlag = (name, fallback = false) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    if (/^(?:1|true|yes|on)$/i.test(raw)) return true;
    if (/^(?:0|false|no|off)$/i.test(raw)) return false;
    throw new Error(`Invalid ${name}="${raw}": use true or false.`);
};

// Relative paths in .env are resolved from the server folder, not from wherever node was started
const readPath = (name, fallback) => path.resolve(SERVER_ROOT, env[name] || fallback);

// "eng" or "eng+hin" or "eng,hin"  ->  ["eng", "hin"]
const languages = (env.OCR_LANGUAGES || "eng")
    .split(/[+,\s]+/)
    .map((code) => code.trim().toLowerCase())
    .filter(Boolean);

for (const code of languages) {
    if (!/^[a-z]{3}(?:_[a-z]+)?$/.test(code)) {
        throw new Error(`Invalid OCR language code "${code}" in OCR_LANGUAGES (use codes like eng or hin).`);
    }
}
if (languages.length === 0) throw new Error("OCR_LANGUAGES must contain at least one language, for example eng.");

const langPath = readPath("OCR_LANG_PATH", "lang-data");
const tempDir = readPath("OCR_TEMP_DIR", "tmp");

// ---- fail at startup, with instructions, when the language data is not there
if (!fs.existsSync(langPath) || !fs.statSync(langPath).isDirectory()) {
    throw new Error(
        `OCR language data folder not found: ${langPath}\n` +
            `Create it and download the .traineddata file for each language in OCR_LANGUAGES (${languages.join(", ")}) into it, ` +
            `or set OCR_LANG_PATH to the right folder.`
    );
}

// tesseract.js reads either "<lang>.traineddata" or the gzipped "<lang>.traineddata.gz"
const missing = [];
let gzip = false;
for (const code of languages) {
    const plain = fs.existsSync(path.join(langPath, `${code}.traineddata`));
    const zipped = fs.existsSync(path.join(langPath, `${code}.traineddata.gz`));
    if (!plain && !zipped) missing.push(code);
    else if (zipped && !plain) gzip = true;
}
if (missing.length) {
    throw new Error(
        `Missing OCR language data for: ${missing.join(", ")}. ` +
            `Put <code>.traineddata in ${langPath} (see the OCR setup step in the guide).`
    );
}

fs.mkdirSync(tempDir, { recursive: true });

// Tesseract reports 0..100; we work in 0..1. Accept either in .env.
const floorInput = readNumber("OCR_CONFIDENCE_FLOOR", 0.6, { min: 0, max: 100 });
const confidenceFloor = floorInput > 1 ? floorInput / 100 : floorInput;



export const ocrConfig = Object.freeze({
    languages: Object.freeze([...languages]),
    languageString: languages.join("+"), // the form tesseract.js expects: "eng+hin"
    langPath,
    gzip, // pass to the engine so it looks for the right file extension
    tempDir,
    timeoutPerPageMs: readNumber("OCR_TIMEOUT_MS", 60_000, { min: 1_000, integer: true }),
    maxPages: readNumber("OCR_MAX_PAGES", 20, { min: 1, max: 200, integer: true }),
    renderScale: readNumber("OCR_RENDER_SCALE", 3, { min: 1, max: 6 }), // PDF page -> image, multiple of 72 dpi
    minCharsPerPage: readNumber("MIN_TEXT_CHARS_PER_PAGE", 50, { min: 0, integer: true }),
    confidenceFloor, // 0..1
        poolSize: readNumber("OCR_WORKERS", 1, { min: 1, max: 4, integer: true }), // Tesseract workers per worker process
    recycleAfterPages: readNumber("OCR_RECYCLE_AFTER_PAGES", 50, { min: 1, integer: true }), // then replace the worker
        // Image preprocessing (pipeline/ocr/imagePreprocessor.js). Always on: rotate, grayscale,
    // contrast stretch, resize. The three below are OFF by default: switch on one at a time and
    // compare results, because on clean scans they can make recognition WORSE.
    preprocess: Object.freeze({
        denoise: readFlag("OCR_PREPROCESS_DENOISE"),
        sharpen: readFlag("OCR_PREPROCESS_SHARPEN"),
        threshold: readFlag("OCR_PREPROCESS_THRESHOLD"),
        thresholdLevel: readNumber("OCR_THRESHOLD_LEVEL", 128, { min: 1, max: 254, integer: true }),
        minWidth: readNumber("OCR_MIN_IMAGE_WIDTH", 1500, { min: 100, integer: true }), // narrower than this: enlarge
        targetWidth: readNumber("OCR_TARGET_IMAGE_WIDTH", 2000, { min: 500, integer: true }), // ...to this
        maxWidth: readNumber("OCR_MAX_IMAGE_WIDTH", 3500, { min: 1000, integer: true }), // wider than this: shrink to it
    }),
});

