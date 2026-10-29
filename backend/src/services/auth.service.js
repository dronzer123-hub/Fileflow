import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import { ApiError } from "../utils/ApiError.js";

// Compared against when the email is unknown, so a missing account
// takes about as long to reject as a wrong password.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

const invalidCredentials = () => ApiError.unauthorized("Invalid credentials.");

// Creates a fresh access + refresh token pair and stores the refresh hash
const issueTokens = async (user) => {
    const accessToken = user.generateAccessToken();
    const refreshToken = user.generateRefreshToken();

    user.setRefreshToken(refreshToken);
    await user.save({ validateBeforeSave: false });

    return { accessToken, refreshToken };
};

export const registerUser = async (input) => {
    // Copy only the three allowed fields: never role or anything else
    const { name, email, password } = input;

    try {
        const user = await User.create({ name, email, password }); // model hook hashes the password
        return user.toJSON(); // password and refreshToken are stripped
    } catch (error) {
        // Duplicate key from the unique email index (also safe against two simultaneous sign-ups)
        if (error?.code === 11000) {
            throw ApiError.conflict("An account with this email already exists.");
        }
        throw error;
    }
};

export const loginUser = async ({ email, password }) => {
    const user = await User.findOne({ email }).select("+password");

    const passwordMatches = user
        ? await user.isPasswordCorrect(password)
        : await bcrypt.compare(password, DUMMY_HASH).then(() => false);

    // Same error whether the email or the password was wrong
    if (!user || !passwordMatches) throw invalidCredentials();

    const { accessToken, refreshToken } = await issueTokens(user);
    return { user: user.toJSON(), accessToken, refreshToken };
};

// Optional: exchange a valid refresh token for a new pair (rotation)
export const refreshSession = async (incomingToken) => {
    if (!incomingToken) throw invalidCredentials();

    let decoded;
    try {
        decoded = jwt.verify(incomingToken, process.env.REFRESH_TOKEN_SECRET);
    } catch {
        throw invalidCredentials(); // expired, malformed or wrongly signed
    }

    const user = await User.findById(decoded._id).select("+refreshToken");
    if (!user) throw invalidCredentials();

    if (!user.isRefreshTokenValid(incomingToken)) {
        // A real token that no longer matches means it was already used or
        // replaced: treat it as possible theft and end the session.
        await User.updateOne({ _id: user._id }, { $unset: { refreshToken: 1 } });
        throw invalidCredentials();
    }

    const { accessToken, refreshToken } = await issueTokens(user);
    return { user: user.toJSON(), accessToken, refreshToken };
};

// Optional: invalidate the stored refresh token
export const logoutUser = async (userId) => {
    await User.updateOne({ _id: userId }, { $unset: { refreshToken: 1 } });
};

export const getCurrentUser = async (userId) => {
    const user = await User.findById(userId);
    if (!user) throw ApiError.unauthorized("Account no longer exists.");
    return user.toJSON();
};