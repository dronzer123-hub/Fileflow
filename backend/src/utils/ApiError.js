class ApiError extends Error {
    constructor(statusCode, message = "Something went wrong", errors = [], stack = "") {
        super(message);
        this.name = "ApiError";
        this.statusCode = statusCode;
        this.data = null;
        this.success = false;
        this.errors = errors;
        this.isOperational = true; // an expected error, not a bug

        if (stack) {
            this.stack = stack;
        } else {
            Error.captureStackTrace(this, this.constructor);
        }
    }

    // Alias, so code can read either error.errors or error.details
    get details() {
        return this.errors;
    }

    static badRequest(message = "Bad request", errors = []) {
        return new ApiError(400, message, errors);
    }

    static unauthorized(message = "Authentication required") {
        return new ApiError(401, message);
    }

    static forbidden(message = "You do not have permission to do this") {
        return new ApiError(403, message);
    }

    static notFound(message = "Resource not found") {
        return new ApiError(404, message);
    }

    static conflict(message = "Conflict") {
        return new ApiError(409, message);
    }

    static payloadTooLarge(message = "Payload too large") {
        return new ApiError(413, message);
    }
}

export { ApiError };