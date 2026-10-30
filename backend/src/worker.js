import "dotenv/config"; // must be first, so settings are loaded before anything reads them
import { Worker, UnrecoverableError } from "bullmq";
import { connectDB, disconnectDB } from "./config/db.js";
import { redisConnection } from "./config/redis.js";
import { QUEUE_NAME } from "./config/queue.js";
import { Job } from "./models/Job.js";
import { recordEvent } from "./services/event.service.js";
import { processJob } from "./pipeline/processor.js";
import { logger } from "./utils/logger.js";

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY) || 1;
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 60000;

let worker;
let shuttingDown = false;

// BullMQ calls "failed" after every failed attempt. This is true only on the last one.
const isFinalFailure = (queueJob, error) =>
    error instanceof UnrecoverableError ||
    (queueJob && queueJob.attemptsMade >= (queueJob.opts?.attempts ?? 1));

// Safety net: the processor normally marks the job failed itself. But if BullMQ gives up
// without the processor running to the end (for example a job that stalled too many
// times), the job would stay "processing" forever. Fix that here.
const ensureJobMarkedFailed = async (queueJob, error) => {
    const jobId = queueJob?.data?.jobId;
    if (!jobId) return;

    const result = await Job.updateOne(
        { _id: jobId, status: { $in: ["queued", "processing"] } },
        { $set: { status: "failed", lastError: error.message.slice(0, 500), finishedAt: new Date() } }
    );
    if (result.modifiedCount > 0) {
        await recordEvent(jobId, "failed", error.message, { reason: "queue gave up" });
    }
};

const start = async () => {
    await connectDB();

    worker = new Worker(QUEUE_NAME, processJob, {
        connection: redisConnection,
        concurrency: CONCURRENCY,
        // How long a job can go without renewing its lock before it counts as stalled
        lockDuration: Number(process.env.WORKER_LOCK_MS) || 60000,
    });

    worker.on("completed", (queueJob) => {
        logger.info({ jobId: queueJob.data?.jobId, queueJobId: queueJob.id }, "Job completed");
    });

    worker.on("failed", async (queueJob, error) => {
        const final = isFinalFailure(queueJob, error);
        logger.error(
            {
                err: error,
                jobId: queueJob?.data?.jobId,
                attempt: queueJob?.attemptsMade,
                maxAttempts: queueJob?.opts?.attempts,
                final,
            },
            final ? "Job failed for good" : "Job attempt failed, will retry"
        );

        if (final) {
            try {
                await ensureJobMarkedFailed(queueJob, error);
            } catch (err) {
                logger.error({ err }, "Could not mark failed job in the database");
            }
        }
    });

    worker.on("stalled", (queueJobId) => {
        logger.warn({ queueJobId }, "Job stalled and will be picked up again");
    });

    // Without this listener a Redis error would crash the process
    worker.on("error", (error) => {
        logger.error({ err: error }, "Worker error");
    });

    logger.info({ queue: QUEUE_NAME, concurrency: CONCURRENCY }, "Worker started");
};

// Let the current job(s) finish, then close everything
const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, "Shutting down worker...");

    // If a job takes too long to finish, exit anyway. BullMQ will give the unfinished
    // job to another worker once its lock expires.
    const forceTimer = setTimeout(() => {
        logger.error("Shutdown took too long, forcing exit");
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    try {
        if (worker) await worker.close(); // waits for jobs that are running right now
        await disconnectDB();
        logger.info("Worker stopped cleanly");
        process.exit(0);
    } catch (error) {
        logger.error({ err: error }, "Error during shutdown");
        process.exit(1);
    }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (error) => {
    logger.error({ err: error }, "Unhandled promise rejection");
    shutdown("unhandledRejection");
});
process.on("uncaughtException", (error) => {
    logger.error({ err: error }, "Uncaught exception");
    shutdown("uncaughtException");
});

start().catch((error) => {
    logger.error({ err: error }, "Worker failed to start");
    process.exit(1);
});