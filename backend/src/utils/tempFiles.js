import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ocrConfig } from "../config/ocr.js";
import { logger } from "./logger.js";

const PREFIX = "job-"; // the sweep only ever touches folders that start with this
const STALE_AFTER_MS = 60 * 60 * 1000; // one hour

// A path counts as ours only if it sits INSIDE the OCR temp folder and has our prefix.
// This is what stops a bug (or a hostile value) from turning "cleanup" into "delete anything".
const isOurTempDir = (dir) => {
    const resolved = path.resolve(dir);
    const relative = path.relative(ocrConfig.tempDir, resolved);
    return (
        relative !== "" &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative) &&
        !relative.includes(path.sep) && // direct child only
        relative.startsWith(PREFIX)
    );
};

// Job ids are ObjectId strings, but never trust a value that becomes part of a path
const safeName = (value) => String(value ?? "x").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "x";

/** Creates a unique folder for one job and returns its absolute path. */
export const createJobTempDir = async (jobId) => {
    await fs.mkdir(ocrConfig.tempDir, { recursive: true });
    // randomUUID makes a retry of the same job get a fresh folder (no stale files from an earlier attempt)
    const dir = path.join(ocrConfig.tempDir, `${PREFIX}${safeName(jobId)}-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(dir);
    return dir;
};

/** Deletes a folder made by createJobTempDir. Never throws: cleanup must not hide the real result or error. */
export const removeTempDir = async (dir) => {
    if (!dir) return;
    if (!isOurTempDir(dir)) {
        logger.error({ dir }, "Refusing to delete a folder outside the OCR temp directory");
        return;
    }
    try {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); // retries help on Windows file locks
    } catch (err) {
        logger.warn({ err, dir }, "Could not remove temp folder; the startup sweep will retry later");
    }
};

/**
 * Runs `work(dir)` with a fresh temp folder and ALWAYS removes it afterwards:
 * after success, after an error, and after a timeout (the error path runs the finally too).
 */
export const withTempDir = async (jobId, work) => {
    const dir = await createJobTempDir(jobId);
    try {
        return await work(dir);
    } finally {
        await removeTempDir(dir);
    }
};

/**
 * Startup sweep: removes leftover job folders older than an hour.
 * A worker that was killed (crash, power cut, docker stop) cannot clean up after itself.
 * Returns how many folders were removed.
 */
export const sweepStaleTempDirs = async ({ olderThanMs = STALE_AFTER_MS } = {}) => {
    let removed = 0;
    let entries;
    try {
        entries = await fs.readdir(ocrConfig.tempDir, { withFileTypes: true });
    } catch (err) {
        if (err.code !== "ENOENT") logger.warn({ err }, "Could not read the OCR temp directory");
        return 0;
    }

    const cutoff = Date.now() - olderThanMs;
    for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue; // leaves .gitkeep and strangers alone
        const dir = path.join(ocrConfig.tempDir, entry.name);
        try {
            const { mtimeMs } = await fs.stat(dir);
            if (mtimeMs >= cutoff) continue; // may belong to a job running right now
            await removeTempDir(dir);
            removed++;
        } catch (err) {
            logger.warn({ err, dir }, "Skipped a temp folder during the sweep");
        }
    }
    if (removed > 0) logger.info({ removed }, "Removed stale OCR temp folders");
    return removed;
};