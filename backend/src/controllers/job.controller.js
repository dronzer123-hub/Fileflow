import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { verifyUploadedFile } from "../utils/fileTypeDetector.js";
import { saveFile, deleteFile } from "../services/storage.service.js";
import { createJobFromUpload } from "../services/job.service.js";

// The fields the client needs after an upload
const toJobSummary = (job) => ({
    id: job._id,
    originalName: job.originalName,
    mimeType: job.mimeType,
    sizeBytes: job.sizeBytes,
    jobType: job.jobType,
    status: job.status,
    attempts: job.attempts,
    createdAt: job.createdAt,
});

export const uploadFile = asyncHandler(async (req, res) => {
    // Multer does not complain when no file is sent, so check here
    if (!req.file) {
        throw ApiError.badRequest("No file received. Send it in a form-data field named file.");
    }

    let stored;
    let job;

    try {
        const verified = await verifyUploadedFile(req.file); // checks the real type, deletes the file if rejected
        stored = await saveFile(req.file);
        job = await createJobFromUpload({
            ownerId: req.user._id,
            file: req.file,
            stored,
            verified,
        });
    } catch (error) {
        // Safety net: whichever step failed, make sure no orphan file stays on disk.
        // Deleting an already-deleted file is harmless.
        await deleteFile(stored?.storagePath ?? req.file.filename);
        throw error;
    }

    res.status(201).json({
        success: true,
        message: "File uploaded.",
        data: { job: toJobSummary(job) },
    });
});