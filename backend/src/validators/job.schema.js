import { z } from "zod";
import { JOB_STATUSES, JOB_TYPES } from "../models/Job.js";

// The frontend often sends empty strings for "no filter selected".
// Treat them as "not provided" instead of as invalid values.
const optional = (schema) =>
    z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

export const listJobsQuerySchema = z.object({
    page: z.coerce.number().int().min(1, "Page must be 1 or higher.").max(100000).default(1),
    limit: z.coerce
        .number()
        .int()
        .min(1, "Limit must be at least 1.")
        .max(50, "Limit cannot be more than 50.")
        .default(10),
    status: optional(z.enum(JOB_STATUSES)),
    jobType: optional(z.enum(JOB_TYPES)),
    search: optional(z.string().trim().max(100, "Search text is too long.")),
    sort: z.enum(["newest", "oldest"]).default("newest"),
});

export const jobIdParamSchema = z.object({
    id: z.string().regex(/^[a-f\d]{24}$/i, "Invalid job id."),
});