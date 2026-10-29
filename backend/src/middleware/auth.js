import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Protects a route: requires a valid access token and attaches the user to req.user
export const authenticate = asyncHandler(async (req, res, next) => {
    // Expect: Authorization: Bearer <token>
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
    if (!match) throw ApiError.unauthorized("Authentication required.");

    let payload;
    try {
        payload = jwt.verify(match[1], process.env.ACCESS_TOKEN_SECRET, {
            algorithms: ["HS256"], // only accept the algorithm you sign with
        });
    } catch (error) {
        throw ApiError.unauthorized(
            error.name === "TokenExpiredError" ? "Access token expired." : "Invalid access token."
        );
    }

    // Load the user so deleted accounts and role changes take effect immediately
    const user = await User.findById(payload._id).select("_id name email role").lean();
    if (!user) throw ApiError.unauthorized("Account no longer exists.");

    req.user = user;
    next();
});

// Restricts a route to certain roles. Always use it after authenticate.
export const authorizeRoles = (...allowedRoles) => (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized("Authentication required."));

    if (!allowedRoles.includes(req.user.role)) {
        return next(ApiError.forbidden("You do not have permission to do this."));
    }
    next();
};