import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { QUEUE_NAME, DEFAULT_JOB_OPTIONS } from "../config/queue.js";
import { logger } from "../utils/logger.js";

const ENQUEUE_TIMEOUT_MS = Number(process.env.ENQUEUE_TIMEOUT_MS) || 5000;

export const fileQueue = new Queue(QUEUE_NAME, {
    connection: redisConnection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

// Without a listener, a Redis connection error would crash the whole API
fileQueue.on("error", (error) => {
    logger.error({ err: error }, "Queue connection error");
});

// If Redis is down, queue commands wait for it to come back. Give up after a few
// seconds so an upload fails cleanly instead of hanging.
const withTimeout = (promise) => {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new Error("The queue is not responding. Is Redis running?")),
            ENQUEUE_TIMEOUT_MS
        );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Puts a job on the queue. The message holds only ids: the worker loads
 * everything else from MongoDB, which stays the source of truth.
 * Returns the queue job (its id is what the Job document stores as queueJobId).
 */
export const addProcessingJob = async (jobId, jobType) => {
    const id = String(jobId); // the Mongo id doubles as the queue id, which prevents duplicates

    const existing = await withTimeout(fileQueue.getJob(id));
    if (existing) {
        const state = await withTimeout(existing.getState());

        if (state === "completed" || state === "failed") {
            // A finished entry with the same id would make BullMQ silently ignore the new one
            // (this is the retry case), so clear it first.
            await withTimeout(existing.remove());
        } else {
            return existing; // already waiting, delayed or running: do not add a duplicate
        }
    }

    return withTimeout(fileQueue.add(jobType, { jobId: id, jobType }, { jobId: id }));
};

export const closeQueue = async () => {
    await fileQueue.close();
};