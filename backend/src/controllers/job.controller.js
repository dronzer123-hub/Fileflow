import { pipeline } from "node:stream/promises";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { verifyUploadedFile } from "../utils/fileTypeDetector.js";
import { saveFile, deleteFile, getFileStream } from "../services/storage.service.js";
import * as jobService from "../services/job.service.js";

// The fields the client needs for a job in a list, after an upload, or after a retry.
// Never storagePath, storedName or queueJobId: where files live on the server is private.
const toJobSummary = (job) => ({
    id: job._id,
    originalName: job.originalName,
    mimeType: job.mimeType,
    sizeBytes: job.sizeBytes,
    jobType: job.jobType,
    status: job.status,
    attempts: job.attempts,
    lastError: job.lastError ?? null,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt ?? null,
});

const toJobDetail = (job) => ({
    ...toJobSummary(job),
    maxAttempts: job.maxAttempts,
    startedAt: job.startedAt ?? null,
    updatedAt: job.updatedAt,
});

const toEvent = (event) => ({
    id: event._id,
    type: event.type,
    message: event.message,
    metadata: event.metadata ?? {},
    createdAt: event.createdAt,
});

const toResult = (result) => {
    if (!result) return null;
    const { _id, __v, job, ...rest } = result;
    return { id: _id, ...rest };
};

// Validated input lives in req.validated (the validate middleware); Express 5 makes req.query read-only
const idFrom = (req) => req.validated?.params?.id ?? req.params.id;

// ---------------------------------------------------------------- upload
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
        job = await jobService.createJobFromUpload({
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

// ---------------------------------------------------------------- list, detail, stats
export const listJobs = asyncHandler(async (req, res) => {
    const { items, total, page, limit, totalPages } = await jobService.listJobs({
        ownerId: req.user._id,
        ...req.validated.query,
    });

    res.json({
        success: true,
        data: {
            jobs: items.map(toJobSummary),
            pagination: { page, limit, total, totalPages, hasMore: page < totalPages },
        },
    });
});

export const getJob = asyncHandler(async (req, res) => {
    const { job, result, events } = await jobService.getJobDetail({ jobId: idFrom(req), ownerId: req.user._id });

    res.json({
        success: true,
        data: { job: toJobDetail(job), result: toResult(result), events: events.map(toEvent) },
    });
});

export const getStats = asyncHandler(async (req, res) => {
    const stats = await jobService.getStats({ ownerId: req.user._id });
    res.json({ success: true, data: stats });
});

// ---------------------------------------------------------------- retry, delete
export const retryJob = asyncHandler(async (req, res) => {
    const job = await jobService.retryJob({ jobId: idFrom(req), ownerId: req.user._id });

    // The service never throws for queue trouble: it returns the job, "queued" or marked "failed" again
    const queued = job.status === "queued";
    res.status(queued ? 202 : 503).json({
        success: queued,
        message: queued ? "Job queued again." : "The job could not be queued. Please try again later.",
        data: { job: toJobSummary(job) },
    });
});

export const deleteJob = asyncHandler(async (req, res) => {
    await jobService.deleteJob({ jobId: idFrom(req), ownerId: req.user._id });
    res.json({ success: true, message: "Job deleted." });
});

// ---------------------------------------------------------------- download
export const downloadFile = asyncHandler(async (req, res) => {
    // 404 for a missing job AND for someone else's job
    const file = await jobService.getJobFile({ jobId: idFrom(req), ownerId: req.user._id });

    // Open the file BEFORE touching the headers: if it is missing we can still send a normal JSON 404
    const stream = await getFileStream(file.storagePath);

    // attachment(): "Content-Disposition: attachment" with the name encoded safely (quotes, accents, spaces)
    res.attachment(file.originalName);
    res.type(file.mimeType); // the type we verified at upload, not whatever the name's extension suggests
    res.set("X-Content-Type-Options", "nosniff"); // the browser must not guess "this is HTML" and run it
    res.set("Cache-Control", "private, no-store"); // an invoice is personal: no shared caches

    try {
        await pipeline(stream, res);
    } catch (error) {
        // After the first bytes are sent we can no longer send an error page: just cut the connection.
        // A user closing the tab mid-download is normal, not an error.
        if (!res.headersSent) throw error;
        res.destroy();
    }
});