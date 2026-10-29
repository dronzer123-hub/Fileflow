import pino from "pino";

const environment = process.env.NODE_ENV || "development";

const defaultLevels = {
    production: "info",
    development: "debug",
    test: "silent", // keep test output clean
};

export const logger = pino({
    // LOG_LEVEL overrides the default for the current environment
    level: process.env.LOG_LEVEL || defaultLevels[environment] || "debug",

    // Never let secrets reach the logs, even by accident
    redact: {
        paths: [
            "password",
            "*.password",
            "refreshToken",
            "*.refreshToken",
            "accessToken",
            "*.accessToken",
            "req.headers.authorization",
            "req.headers.cookie",
            'res.headers["set-cookie"]',
        ],
        censor: "[redacted]",
    },

    // Readable, colored output while developing; plain JSON lines in production
    ...(environment === "development" && {
        transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
        },
    }),
});

export default logger;