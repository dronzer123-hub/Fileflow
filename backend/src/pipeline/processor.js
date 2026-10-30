import { UnrecoverableError } from "bullmq";
import { Job } from "../models/Job.js";
import { ExtractionResult } from "../models/ExtractionResult.js";
import { recordEvent } from "../services/event.service.js";
import { ApiError } from "../utils/ApiError.js";
import { PermanentJobError } from "../utils/jobErrors.js";
import { logger } from "../utils/logger.js";
import { handleInvoice } from "./invoiceHandler.js";

/*
 * A handler receives { job, log } and returns one object with any of these keys:
 *   invoiceNumber, invoiceDate, vendorName, totalAmount, currency,
 *   extraFields, lineItems, extractionMethod, parserUsed,
 *   confidence (0..1), fieldConfidence, rawText, ocrInfo, validationErrors,
 *   needsReview (optional: true forces a human review)
 * It throws PermanentJobError for problems that retrying cannot fix.
 */
const HANDLERS = {
    invoice_extraction: handleInvoice,
    // csv_import: add a handler here when you build milestone M7
};

const REVIEW_THRESHOLD = Number(process.env.REVIEW_CONFIDENCE_THRESHOLD) || 0.7;

const RESULT_FIELDS = [
    "invoiceNumber", "invoiceDate", "vendorName", "totalAmount", "currency",
    "extraFields", "lineItems", "extractionMethod", "parserUsed",
    "confidence", "fieldConfidence", "rawText", "ocrInfo", "validationErrors",
];
// If the handler did not find these, remove any stale value from an earlier attempt
const CLEARABLE_FIELDS = ["invoiceNumber", "invoiceDate", "vendorName", "totalAmount", "currency", "ocrInfo"];

const MAX_RAW_TEXT = 200000; // same limit as the model

// Saves the result with an upsert keyed on the job id, so a job delivered twice
// overwrites its own result instead of creating a second one.
const saveResult = async (jobId, output) => {
    const data = {};
    for (const key of RESULT_FIELDS) {
        if (output[key] !== undefined && output[key] !== null) data[key] = output[key];
    }
    if (typeof data.rawText === "string") data.rawText = data.rawText.slice(0, MAX_RAW_TEXT);

    const update = { $set: data };
    const cleared = CLEARABLE_FIELDS.filter((key) => data[key] === undefined);
    if (cleared.length > 0) update.$unset = Object.fromEntries(cleared.map((key) => [key, ""]));

    await ExtractionResult.findOneAndUpdate({ job: jobId }, update, {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
    });
};

// Errors that retrying cannot fix
const isPermanent = (error) =>
    error instanceof UnrecoverableError ||
    error instanceof ApiError ||          // for example "File not found" from the storage service
    error.name === "ValidationError" ||   // the result itself was invalid: it would be invalid again
    error.code === "ENOENT";              // the file is gone

// The message a user may see. Technical details stay in the logs.
const userMessage = (error) =>
    error instanceof UnrecoverableError || error instanceof ApiError
        ? error.message
        : error.name === "ValidationError"
            ? "The extracted data could not be saved because it was invalid."
            : "An unexpected error occurred while processing this file.";

export const processJob = async (queueJob) => {
    const { jobId } = queueJob.data;
    const log = logger.child({ jobId, queueJobId: queueJob.id });

    // 1. Claim the job. Nothing is claimed if it was deleted or is already finished
    //    (a job can be delivered twice).
    const job = await Job.findOneAndUpdate(
        { _id: jobId, status: { $in: ["queued", "processing"] } },
        {
            $set: { status: "processing", startedAt: new Date(), finishedAt: null, lastError: null },
            $inc: { attempts: 1 },
        },
        { new: true }
    );

    if (!job) {
        log.warn("Job no longer exists or is already finished: skipping");
        return { skipped: true };
    }

    const startedAt = Date.now();
    await recordEvent(job._id, "started", `Processing started (attempt ${job.attempts} of ${job.maxAttempts}).`, {
        attempt: job.attempts,
    });

    try {
        // 2. Choose the handler by job type
        const handler = HANDLERS[job.jobType];
        if (!handler) throw new PermanentJobError(`This job type (${job.jobType}) is not supported yet.`);

        const output = await handler({ job, log });

        // 3. Decide the final status
        const validationErrors = output.validationErrors ?? [];
        const confidence = typeof output.confidence === "number" ? output.confidence : 0;
        const needsReview =
            output.needsReview === true || validationErrors.length > 0 || confidence < REVIEW_THRESHOLD;

        // 4. Save the result, then the status
        await saveResult(job._id, { ...output, confidence, validationErrors });

        const status = needsReview ? "needs_review" : "completed";
        await Job.updateOne({ _id: job._id }, { $set: { status, finishedAt: new Date(), lastError: null } });

        const durationMs = Date.now() - startedAt;
        if (needsReview) {
            await recordEvent(job._id, "validation_failed", "Needs review: the extraction was not certain enough.", {
                confidence,
                errors: validationErrors,
                durationMs,
            });
        } else {
            await recordEvent(job._id, "completed", "Processing completed.", { confidence, durationMs });
        }

        log.info({ status, confidence, durationMs }, "Job processed");
        return { status };
    } catch (error) {
        const permanent = isPermanent(error);
        const isLastAttempt = queueJob.attemptsMade + 1 >= (queueJob.opts?.attempts ?? 1);
        const message = userMessage(error).slice(0, 500);

        log.error({ err: error, permanent, isLastAttempt }, "Job attempt failed");

        if (permanent || isLastAttempt) {
            // Final failure: no more retries
            await Job.updateOne(
                { _id: job._id },
                { $set: { status: "failed", lastError: message, finishedAt: new Date() } }
            );
            await recordEvent(job._id, "failed", message, { attempt: job.attempts, permanent });

            // A permanent error must be an UnrecoverableError so BullMQ does not retry it
            throw permanent && !(error instanceof UnrecoverableError)
                ? new PermanentJobError(message)
                : error;
        }

        // Temporary failure with attempts left: back to "queued", and rethrow so BullMQ retries
        await Job.updateOne({ _id: job._id }, { $set: { status: "queued", lastError: message } });
        await recordEvent(job._id, "retried", `Attempt ${job.attempts} of ${job.maxAttempts} failed. Retrying automatically.`, {
            attempt: job.attempts,
        });
        throw error;
    }
};