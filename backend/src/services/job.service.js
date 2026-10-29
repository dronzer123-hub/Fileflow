import path from "path";
import { Job } from "../models/Job.js";
import { recordEvent } from "./event.service.js";
import { deleteFile } from "./storage.service.js";

// Which handler a file will need, based on what the file really is
const jobTypeForCategory = (category) =>
    category === "csv" ? "csv_import" : "invoice_extraction";

// Browsers can send odd file names: strip folders and control characters, cap the length
const cleanOriginalName = (name) => {
    const cleaned = path
        .basename(String(name ?? ""))
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, 200);
    return cleaned || "upload";
};

/**
 * Creates the Job for a file that was uploaded, verified and stored.
 *
 *  ownerId   - the logged-in user's id (req.user._id)
 *  file      - the Multer file object (req.file)
 *  stored    - the result of saveFile(): { storedName, storagePath, sizeBytes }
 *  verified  - the result of verifyUploadedFile(): { category, mimeType }
 */
export const createJobFromUpload = async ({ ownerId, file, stored, verified }) => {
    let job;

    try {
        job = await Job.create({
            owner: ownerId,
            originalName: cleanOriginalName(file.originalname),
            storedName: stored.storedName,
            storagePath: stored.storagePath,
            sizeBytes: stored.sizeBytes,
            mimeType: verified.mimeType,
            jobType: jobTypeForCategory(verified.category),
            status: "queued",
        });
    } catch (error) {
        // No job means nobody will ever reference this file, so remove it
        await deleteFile(stored.storagePath);
        throw error;
    }

    await recordEvent(job._id, "uploaded", "File uploaded.", {
        originalName: job.originalName,
        sizeBytes: job.sizeBytes,
        mimeType: job.mimeType,
    });

    return job;
};