import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticate } from "../middleware/auth.js";
import { uploadSingle } from "../middleware/upload.js";
import { uploadFile } from "../controllers/job.controller.js";

const router = Router();

// Every job route requires a logged-in user
router.use(authenticate);

// Limits uploads per user (not per IP), because OCR jobs are expensive
const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user._id),
    message: { success: false, message: "Too many uploads. Please wait a few minutes." },
});

// Order matters: identity -> limit -> save the file -> controller
router.post("/", uploadLimiter, uploadSingle, uploadFile);

export default router;