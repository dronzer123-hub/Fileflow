import { ApiError } from "../utils/ApiError.js";

const SOURCES = ["body", "query", "params"];

/**
 * validate(schema)            -> checks req.body
 * validate(schema, "query")   -> checks req.query
 * validate(schema, "params")  -> checks req.params
 */
export const validate = (schema, source = "body") => {
    if (!SOURCES.includes(source)) {
        throw new Error(`validate: source must be one of ${SOURCES.join(", ")}`);
    }

    return (req, res, next) => {
        // A missing body becomes {} so the user gets field-level errors
        const result = schema.safeParse(req[source] ?? {});

        if (!result.success) {
            const details = result.error.issues.map((issue) => ({
                field: issue.path.join(".") || source,
                message: issue.message,
            }));

            return next(ApiError.badRequest("Validation failed.", details));
        }

        // Controllers should read the cleaned values, not the raw input
        req.validated = { ...req.validated, [source]: result.data };
        if (source === "body") req.body = result.data;

        next();
    };
};