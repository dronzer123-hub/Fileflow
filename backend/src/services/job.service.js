import path from "path";
import { Job } from "../models/Job.js";
import { recordEvent } from "./event.service.js";
import { deleteFile } from "./storage.service.js";
import { addProcessingJob } from "../queue/jobQueue.js";
import { ApiError } from "../utils/ApiError.js";
import { logger } from "../utils/logger.js";

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

// Used when the queue cannot be reached: the job is marked failed, not left stuck as queued
const markQueueFailure = async (job, error) => {
    logger.error({ err: error, jobId: job._id }, "Could not add job to the queue");

    job.status = "failed";
    job.lastError = "Could not add the job to the queue. Please try again later.";
    job.finishedAt = new Date();
    await job.save();

    await recordEvent(job._id, "failed", job.lastError, {});
    return job;
};

// Puts a saved job on the queue. Never throws for queue problems: it returns the job,
// which is either still "queued" (success) or marked "failed".
const enqueue = async (job) => {
    // Recorded BEFORE adding to the queue, so the worker's "started" event
    // can never appear ahead of it in the timeline.
    await recordEvent(job._id, "queued", "Queued for processing.", { jobType: job.jobType });

    let queueJob;
    try {
        queueJob = await addProcessingJob(job._id, job.jobType);
    } catch (error) {
        return markQueueFailure(job, error);
    }

    try {
        await Job.updateOne({ _id: job._id }, { $set: { queueJobId: String(queueJob.id) } });
        job.queueJobId = String(queueJob.id);
    } catch (error) {
        // The job IS queued, so this is not a failure: only the cross-reference is missing
        logger.warn({ err: error, jobId: job._id }, "Could not store queueJobId");
    }
    return job;
};

/**
 * Creates the Job for a file that was uploaded, verified and stored, then queues it.
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

    return enqueue(job);
};

/**
 * Re-queues a failed job. Only the owner can do it, and only while status is "failed".
 */
export const retryJob = async ({ jobId, ownerId }) => {
    // One atomic step: it checks the owner and the status AND resets the job, so two
    // quick clicks on "Retry" cannot queue the same job twice.
    const job = await Job.findOneAndUpdate(
        { _id: jobId, owner: ownerId, status: "failed" },
        {
            $set: {
                status: "queued",
                attempts: 0,
                lastError: null,
                startedAt: null,
                finishedAt: null,
                queueJobId: null,
            },
        },
        { new: true }
    );

    if (!job) {
        const exists = await Job.exists({ _id: jobId, owner: ownerId });
        // Someone else's job and a missing job look the same on purpose
        throw exists
            ? ApiError.conflict("Only failed jobs can be retried.")
            : ApiError.notFound("Job not found.");
    }

    await recordEvent(job._id, "retried", "Retry requested.", {});
    return enqueue(job);
};