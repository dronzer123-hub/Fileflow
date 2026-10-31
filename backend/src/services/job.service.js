import path from "path";
import mongoose from "mongoose";
import { Job, JOB_STATUSES } from "../models/Job.js";
import { JobEvent } from "../models/JobEvent.js";
import { ExtractionResult } from "../models/ExtractionResult.js";
import { User } from "../models/User.js";
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

// ====================================================================== queries

// Fields the client must never see: where the file lives on the server and the queue's internal id
const HIDDEN_JOB_FIELDS = "-storagePath -storedName -queueJobId -__v";

// A search like "inv(2024" must be treated as text, not as a regular expression
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isObjectId = (value) => mongoose.isValidObjectId(value) && String(value).length === 24;

/**
 * The caller's jobs, newest first by default.
 *   ownerId (required), page, limit, status?, jobType?, search? (part of the file name), sort?
 * Returns { items, total, page, limit, totalPages }
 */
export const listJobs = async ({ ownerId, page = 1, limit = 10, status, jobType, search, sort = "newest" }) => {
    const filter = { owner: ownerId }; // ALWAYS present: this is what keeps users apart
    if (status) filter.status = status;
    if (jobType) filter.jobType = jobType;
    if (search) filter.originalName = { $regex: escapeRegex(search), $options: "i" };

    const direction = sort === "oldest" ? 1 : -1;

    const [items, total] = await Promise.all([
        Job.find(filter)
            .select(HIDDEN_JOB_FIELDS)
            .sort({ createdAt: direction, _id: direction }) // _id breaks ties so pages never repeat or skip a row
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        Job.countDocuments(filter),
    ]);

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
};

/**
 * One job with its extraction result (null until there is one) and its events, oldest first.
 * Another user's job and a job that does not exist give the SAME 404.
 */
export const getJobDetail = async ({ jobId, ownerId }) => {
    if (!isObjectId(jobId)) throw ApiError.notFound("Job not found.");

    const job = await Job.findOne({ _id: jobId, owner: ownerId }).select(HIDDEN_JOB_FIELDS).lean();
    if (!job) throw ApiError.notFound("Job not found.");

    const [result, events] = await Promise.all([
        ExtractionResult.findOne({ job: job._id }).lean(), // rawText is select:false, so it is not included
        JobEvent.find({ job: job._id }).sort({ createdAt: 1, _id: 1 }).lean(),
    ]);

    return { job, result, events };
};

/**
 * Counts per status for the dashboard cards: { total, byStatus: { queued, processing, ... } }
 * Every status is present, with 0 when there are none.
 */
export const getStats = async ({ ownerId }) => {
    // aggregate() does NOT cast strings to ObjectId the way find() does
    const owner = new mongoose.Types.ObjectId(String(ownerId));

    const rows = await Job.aggregate([
        { $match: { owner } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const byStatus = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0]));
    for (const { _id, count } of rows) byStatus[_id] = count;

    const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
    return { total, byStatus };
};

// A job being worked on, or about to be, must not disappear underneath the worker
const DELETABLE_STATUSES = ["completed", "needs_review", "failed"];

/**
 * Removes the job, its result, its events and the stored file. Owner only.
 * Queued and processing jobs cannot be deleted (409): wait until they finish.
 */
export const deleteJob = async ({ jobId, ownerId }) => {
    if (!isObjectId(jobId)) throw ApiError.notFound("Job not found.");

    // One atomic step that checks the owner AND the status AND removes the job, so a retry or a
    // worker claiming the job at the same moment cannot slip in between a check and a delete.
    const job = await Job.findOneAndDelete({
        _id: jobId,
        owner: ownerId,
        status: { $in: DELETABLE_STATUSES },
    }).lean();

    if (!job) {
        const exists = await Job.exists({ _id: jobId, owner: ownerId });
        throw exists
            ? ApiError.conflict("This job is still being processed. Try again when it has finished.")
            : ApiError.notFound("Job not found.");
    }

    // The job is gone; clear everything that pointed at it. One failing step must not stop the others,
    // and leftovers are harmless (nothing references them), so these are logged, not thrown.
    const cleanup = await Promise.allSettled([
        JobEvent.deleteMany({ job: job._id }),
        ExtractionResult.deleteMany({ job: job._id }),
        deleteFile(job.storagePath),
        User.updateOne({ _id: ownerId, jobCount: { $gt: 0 } }, { $inc: { jobCount: -1 } }),
    ]);
    const labels = ["events", "result", "file", "user counter"];
    cleanup.forEach((outcome, index) => {
        if (outcome.status === "rejected") {
            logger.warn({ err: outcome.reason, jobId: job._id }, `Could not remove ${labels[index]} of a deleted job`);
        }
    });

    return { id: String(job._id) };
};

/**
 * What the download route needs: where the file is and what to call it. Owner only.
 * (storagePath is hidden from every other query on purpose; this is the one place it is read.)
 */
export const getJobFile = async ({ jobId, ownerId }) => {
    if (!isObjectId(jobId)) throw ApiError.notFound("Job not found.");

    const job = await Job.findOne({ _id: jobId, owner: ownerId }).select("storagePath originalName mimeType").lean();
    if (!job) throw ApiError.notFound("Job not found.");
    return job;
};