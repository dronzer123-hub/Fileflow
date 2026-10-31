import Tesseract from "tesseract.js";
import { ocrConfig } from "../../config/ocr.js";
import { PermanentJobError } from "../../utils/jobErrors.js";
import { logger } from "../../utils/logger.js";

// The ONLY file that knows about tesseract.js. Everything else calls recognizeImage().
const { createWorker, OEM } = Tesseract;

const slots = new Set(); // every live worker, busy or idle
const idle = []; // healthy workers waiting for work
const waiters = []; // callers waiting for a free worker
let starting = 0; // workers being created right now
let closed = false;

// ---------------------------------------------------------------- worker lifecycle
const createSlot = async () => {
    const slot = { worker: null, pages: 0, broken: false };
    slot.worker = await createWorker(ocrConfig.languageString, OEM.LSTM_ONLY, {
        langPath: ocrConfig.langPath, // local folder: nothing is downloaded at runtime
        gzip: ocrConfig.gzip,
        cacheMethod: "none", // do not write a cache of the language data into the working directory
        errorHandler: (err) => {
            slot.broken = true; // a worker that reported an error is not trusted again
            logger.error({ err }, "Tesseract worker reported an error");
        },
    });
    // Keeps the gaps between columns, which the label-and-value parser relies on
    await slot.worker.setParameters({ preserve_interword_spaces: "1" });
    return slot;
};

const destroy = async (slot) => {
    slots.delete(slot);
    try {
        await slot.worker.terminate();
    } catch (err) {
        logger.warn({ err }, "Could not terminate a Tesseract worker cleanly");
    }
};

const acquire = async () => {
    if (closed) throw new Error("The OCR engine has been shut down.");

    const free = idle.pop();
    if (free) return free;

    if (slots.size + starting < ocrConfig.poolSize) {
        starting++;
        try {
            const slot = await createSlot();
            if (closed) {
                await slot.worker.terminate().catch(() => {});
                throw new Error("The OCR engine has been shut down.");
            }
            slots.add(slot);
            return slot;
        } finally {
            starting--;
        }
    }

    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
};

const release = async (slot) => {
    // Recycle after N pages: Tesseract's WASM memory only grows, so a fresh worker is the fix
    const retire = slot.broken || closed || slot.pages >= ocrConfig.recycleAfterPages;

    if (!retire) {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(slot);
        else idle.push(slot);
        return;
    }

    await destroy(slot);
    if (slot.pages >= ocrConfig.recycleAfterPages) logger.debug({ pages: slot.pages }, "Recycled an OCR worker");

    // Someone may be waiting for the capacity this worker just gave up
    if (waiters.length > 0 && !closed) {
        const waiter = waiters.shift();
        acquire().then(waiter.resolve, waiter.reject);
    }
};

/** Terminates every worker. Call on shutdown and after a fatal error. Safe to call twice. */
export const shutdownOcrEngine = async () => {
    closed = true;
    while (waiters.length) waiters.shift().reject(new Error("The OCR engine has been shut down."));
    idle.length = 0;
    await Promise.all([...slots].map(destroy));
};

/** For tests and debugging. */
export const getOcrEngineStats = () => ({
    workers: slots.size,
    idle: idle.length,
    waiting: waiters.length,
    starting,
    pagesPerWorker: [...slots].map((slot) => slot.pages),
});

// ---------------------------------------------------------------- result shaping
const round3 = (n) => Math.round(n * 1000) / 1000;

const collectWords = (blocks, includeBoxes) => {
    const words = [];
    for (const block of blocks ?? []) {
        for (const paragraph of block.paragraphs ?? []) {
            for (const line of paragraph.lines ?? []) {
                for (const word of line.words ?? []) {
                    const text = (word.text ?? "").trim();
                    if (!text) continue;
                    const item = { text, confidence: round3((word.confidence ?? 0) / 100) };
                    if (includeBoxes) item.bbox = { ...word.bbox };
                    words.push(item);
                }
            }
        }
    }
    return words;
};

// ---------------------------------------------------------------- the one public function
/**
 * recognizeImage({ imagePath, attempt, includeBoxes, timeoutMs })
 *   attempt       which attempt of the JOB this is (1 = first). Decides how a timeout is treated.
 *   includeBoxes  also return each word's position { x0, y0, x1, y1 } in pixels
 *
 * Returns { text, confidence (0..1), words: [{ text, confidence (0..1), bbox? }], durationMs }
 *
 * Timeouts: the first time a page times out it is a TEMPORARY error (the job is retried,
 * perhaps the machine was just busy); on any later attempt it is PERMANENT (the page is the problem).
 */
export const recognizeImage = async ({
    imagePath,
    attempt = 1,
    includeBoxes = false,
    timeoutMs = ocrConfig.timeoutPerPageMs,
}) => {
    const slot = await acquire();
    const startedAt = Date.now();
    let timer;
    let timedOut = false;

    try {
        const work = slot.worker.recognize(imagePath, {}, { text: true, blocks: true });
        work.catch(() => {}); // if we time out first, the late rejection from the killed worker must not crash Node

        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                timedOut = true;
                reject(new Error("OCR timed out"));
            }, timeoutMs);
        });

        const { data } = await Promise.race([work, timeout]);
        slot.pages++;

        return {
            text: (data.text ?? "").trim(),
            confidence: round3((data.confidence ?? 0) / 100),
            words: collectWords(data.blocks, includeBoxes),
            durationMs: Date.now() - startedAt,
        };
    } catch (error) {
        slot.broken = true; // after a timeout or any failure the worker's state is unknown: replace it

        if (timedOut) {
            const seconds = Math.round(timeoutMs / 1000);
            if (attempt > 1) {
                throw new PermanentJobError(`Reading this page took longer than ${seconds}s, again. The page is probably too complex or too large.`);
            }
            throw new Error(`OCR timed out after ${seconds}s (attempt ${attempt}); the job will be retried.`);
        }
        throw error; // unexpected: temporary
    } finally {
        clearTimeout(timer);
        await release(slot);
    }
};