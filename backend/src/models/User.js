import mongoose, { Schema } from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import crypto from "crypto";

const userSchema = new Schema(
    {
        name: {
            type: String,
            required: [true, "Name is required."],
            trim: true,
        },
        email: {
            type: String,
            required: [true, "Email is required."],
            unique: true,
            lowercase: true,
            trim: true,
        },
        password: {
            type: String,
            required: [true, "Password is required."],
            select: false,
        },
        role: {
            type: String,
            enum: ["user", "admin"],
            default: "user",
        },
        refreshToken: {
            type: String, // stores a SHA-256 hash, never the raw token
            select: false,
        },
        // optional counters
        jobCount: {
            type: Number,
            default: 0,
            min: 0,
        },
        lastUploadAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
        toJSON: {
            virtuals: true,
            transform(doc, ret) {
                delete ret.password;
                delete ret.refreshToken;
                delete ret.__v;
                delete ret.id;
                return ret;
            },
        },
        toObject: { virtuals: true },
    }
);


userSchema.virtual("jobs", {
    ref: "Job",
    localField: "_id",
    foreignField: "owner",
});


userSchema.pre("save", async function () {
    if (!this.isModified("password")) return;
    this.password = await bcrypt.hash(this.password, 10);
});

userSchema.methods.isPasswordCorrect = async function (password) {
    return await bcrypt.compare(password, this.password);
};

userSchema.methods.generateAccessToken = function () {
    return jwt.sign(
        { _id: this._id, role: this.role },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: process.env.ACCESS_TOKEN_EXPIRY }
    );
};

userSchema.methods.generateRefreshToken = function () {
    return jwt.sign(
        { _id: this._id },
        process.env.REFRESH_TOKEN_SECRET,
        { expiresIn: process.env.REFRESH_TOKEN_EXPIRY }
    );
};


const hashToken = (token) =>
    crypto.createHash("sha256").update(token).digest("hex");

userSchema.methods.setRefreshToken = function (token) {
    this.refreshToken = hashToken(token);
};

userSchema.methods.isRefreshTokenValid = function (token) {
    return !!this.refreshToken && this.refreshToken === hashToken(token);
};

export const User = mongoose.model("User", userSchema);