// Connection settings shared by the queue (API) and the worker.
// Works for local Docker Redis and for a hosted Redis that needs a password and TLS.
export const redisConnection = {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    ...(process.env.REDIS_TLS === "true" && { tls: {} }),
    maxRetriesPerRequest: null, // BullMQ workers require this
};