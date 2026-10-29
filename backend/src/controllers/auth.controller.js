import { asyncHandler } from "../utils/asyncHandler.js";
import {
    registerUser,
    loginUser,
    refreshSession,
    logoutUser,
    getCurrentUser,
} from "../services/auth.service.js";

// Keep this in step with REFRESH_TOKEN_EXPIRY (here: 7 days)
const REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

const refreshCookieOptions = {
    httpOnly: true, // not readable by browser JavaScript
    secure: process.env.NODE_ENV === "production", // HTTPS only in production
    sameSite: "lax", // use "none" if the client and API are on different sites
    path: "/api/auth", // only sent to the auth routes
};

export const register = asyncHandler(async (req, res) => {
    // req.body was already validated and cleaned by the validate middleware
    const user = await registerUser(req.body);

    res.status(201).json({
        success: true,
        message: "Account created.",
        data: { user },
    });
});

export const login = asyncHandler(async (req, res) => {
    const { user, accessToken, refreshToken } = await loginUser(req.body);

    res
        .status(200)
        .cookie("refreshToken", refreshToken, {
            ...refreshCookieOptions,
            maxAge: REFRESH_COOKIE_MAX_AGE,
        })
        .json({
            success: true,
            message: "Logged in.",
            data: { user, accessToken },
        });
});

export const me = asyncHandler(async (req, res) => {
    // req.user is set by the auth middleware
    const user = await getCurrentUser(req.user._id);

    res.status(200).json({
        success: true,
        data: { user },
    });
});

// Optional: needs the refresh-token flow
export const refresh = asyncHandler(async (req, res) => {
    const { user, accessToken, refreshToken } = await refreshSession(
        req.cookies?.refreshToken
    );

    res
        .status(200)
        .cookie("refreshToken", refreshToken, {
            ...refreshCookieOptions,
            maxAge: REFRESH_COOKIE_MAX_AGE,
        })
        .json({
            success: true,
            data: { user, accessToken },
        });
});

// Optional: needs the refresh-token flow
export const logout = asyncHandler(async (req, res) => {
    await logoutUser(req.user._id);

    res
        .status(200)
        .clearCookie("refreshToken", refreshCookieOptions)
        .json({ success: true, message: "Logged out." });
});