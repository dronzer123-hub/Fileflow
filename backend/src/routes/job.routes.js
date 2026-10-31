import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticate } from "../middleware/auth.js";
import { uploadSingle } from "../middleware/upload.js";
import { validate } from "../middleware/validate.js";
import { jobIdParamSchema, listJobsQuerySchema } from "../validators/job.schema.js";
import {
    deleteJob,
    downloadFile,
    getJob,
    getStats,
    listJobs,
    retryJob,
    uploadFile,
} from "../controllers/job.controller.js";

const router = Router();

// Every job route requires a logged-in user
router.use(authenticate);

// Per-user limits (not per IP): the expensive routes are the ones that start OCR work
const perUser = (max, message) =>
    rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => String(req.user._id),
        message: { success: false, message },
    });

const uploadLimiter = perUser(20, "Too many uploads. Please wait a few minutes.");
const retryLimiter = perUser(30, "Too many retries. Please wait a few minutes.");

const validId = validate(jobIdParamSchema, "params");

// ---- collection routes
// Order matters: identity -> limit -> save the file -> controller
router.post("/", uploadLimiter, uploadSingle, uploadFile);
router.get("/", validate(listJobsQuerySchema, "query"), listJobs);

// MUST be before "/:id", or Express reads the word "stats" as a job id
router.get("/stats", getStats);

// ---- one job
router.get("/:id", validId, getJob);
router.get("/:id/file", validId, downloadFile);
router.post("/:id/retry", validId, retryLimiter, retryJob);
router.delete("/:id", validId, deleteJob);

export default router;