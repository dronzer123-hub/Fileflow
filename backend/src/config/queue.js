// Names and defaults for the BullMQ queue. The producer (API) and the worker both import this file,
// so they always agree on the queue name and job options.

export const QUEUE_NAME = "file-processing";

// Total tries per job, including the first one (same variable the Job model uses for maxAttempts)
export const MAX_ATTEMPTS = Number(process.env.JOB_MAX_ATTEMPTS) || 3;

// Wait before the first retry; it doubles after each failure (5 s, 10 s, 20 s, ...)
export const BACKOFF_DELAY_MS = Number(process.env.QUEUE_BACKOFF_DELAY_MS) || 5000;

const ONE_DAY = 24 * 60 * 60; // BullMQ ages are in seconds

export const DEFAULT_JOB_OPTIONS = {
    attempts: MAX_ATTEMPTS,
    backoff: { type: "exponential", delay: BACKOFF_DELAY_MS },

    // MongoDB is the source of truth for job history, so Redis only keeps a short trail
    removeOnComplete: { age: ONE_DAY, count: 1000 },
    removeOnFail: { age: 7 * ONE_DAY, count: 5000 },
};