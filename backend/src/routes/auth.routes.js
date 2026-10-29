import { Router } from "express";
import rateLimit from "express-rate-limit";
import { validate } from "../middleware/validate.js";
import { authenticate } from "../middleware/auth.js";
import { registerSchema, loginSchema } from "../validators/auth.schema.js";
import { register, login, me, refresh, logout } from "../controllers/auth.controller.js";

const router = Router();

// Stricter than the app-wide limit: slows down password guessing and mass sign-ups
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // requests per IP per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many attempts. Please try again later." },
});

router.post("/register", authLimiter, validate(registerSchema), register);
router.post("/login", authLimiter, validate(loginSchema), login);
router.get("/me", authenticate, me);

// Optional: refresh-token flow
router.post("/refresh", authLimiter, refresh);
router.post("/logout", authenticate, logout);

export default router;