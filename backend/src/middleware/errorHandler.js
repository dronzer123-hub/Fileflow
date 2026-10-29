import multer from "multer";
import { ApiError } from "../utils/ApiError.js";
import { logger } from "../utils/logger.js";

const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB) || 10;

// Turns any error into an ApiError, so the response always has the same shape
const normalizeError = (error) => {
    if (error instanceof ApiError) return error;

    if (error instanceof multer.MulterError) {
        const known = {
            LIMIT_FILE_SIZE: new ApiError(413, `File is too large. Maximum size is ${MAX_FILE_SIZE_MB} MB.`),
            LIMIT_UNEXPECTED_FILE: ApiError.badRequest("Send the file in a form-data field named file."),
            LIMIT_FILE_COUNT: ApiError.badRequest("Upload one file at a time."),
        };
        return known[error.code] ?? ApiError.badRequest(error.message);
    }

    // Mongoose validation (required field missing, value not allowed, ...)
    if (error.name === "ValidationError" && error.errors) {
        const details = Object.values(error.errors).map((e) => ({ field: e.path, message: e.message }));
        return ApiError.badRequest("Validation failed.", details);
    }

    // Mongoose: malformed id, e.g. /api/jobs/abc
    if (error.name === "CastError") {
        return ApiError.badRequest(`Invalid value for ${error.path}.`);
    }

    // MongoDB: duplicate value in a unique index
    if (error.code === 11000) {
        const field = Object.keys(error.keyPattern ?? {})[0] ?? "value";
        return ApiError.conflict(`That ${field} is already in use.`);
    }

    // JWT problems that were not already handled in the auth middleware
    if (error.name === "TokenExpiredError") return ApiError.unauthorized("Access token expired.");
    if (error.name === "JsonWebTokenError") return ApiError.unauthorized("Invalid access token.");

    // express.json() problems
    if (error.type === "entity.parse.failed") return ApiError.badRequest("Request body is not valid JSON.");
    if (error.type === "entity.too.large") return new ApiError(413, "Request body is too large.");

    // Anything else is a bug: do not leak details to the client
    const unexpected = new ApiError(500, "Internal server error.");
    unexpected.isOperational = false;
    return unexpected;
};

// Express recognises an error handler by its four parameters, so keep all four
// eslint-disable-next-line no-unused-vars
export const errorHandler = (error, req, res, next) => {
    const apiError = normalizeError(error);

    if (apiError.statusCode >= 500) {
        logger.error({ err: error, method: req.method, url: req.originalUrl }, "Unhandled error");
    } else {
        logger.debug({ status: apiError.statusCode, url: req.originalUrl }, apiError.message);
    }

    if (res.headersSent) return next(error);

    res.status(apiError.statusCode).json({
        success: false,
        message: apiError.message,
        details: apiError.errors,
        // The stack trace is helpful while developing and must never go to production clients
        ...(process.env.NODE_ENV !== "production" && apiError.statusCode >= 500 && { stack: error.stack }),
    });
};