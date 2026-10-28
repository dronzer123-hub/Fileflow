import mongoose, { Schema } from "mongoose";

const JOB_TYPES = ["invoice_extraction", "csv_import"];
const JOB_STATUSES = ["queued", "processing", "completed", "needs_review", "failed"];

const jobSchema = new Schema(
    {
        owner: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: [true, "Job owner is required."],
        },

        // File metadata
        originalName: {
            type: String,
            required: true,
            trim: true,
        },
        storedName: {
            type: String,
            required: true,
        },
        mimeType: {
            type: String,
            required: true,
        },
        sizeBytes: {
            type: Number,
            required: true,
            min: 0,
        },
        storagePath: {
            type: String,
            required: true,
        },

        // Processing
        jobType: {
            type: String,
            enum: JOB_TYPES,
            default: "invoice_extraction",
        },
        status: {
            type: String,
            enum: JOB_STATUSES,
            default: "queued",
        },
        attempts: {
            type: Number,
            default: 0,
            min: 0,
        },
        maxAttempts: {
            type: Number,
            default: () => Number(process.env.JOB_MAX_ATTEMPTS) || 3,
            min: 1,
        },
        lastError: {
            type: String,
            default: null,
        },
        queueJobId: {
            type: String, // BullMQ job id, for cross-referencing with Redis
            default: null,
        },
        startedAt: {
            type: Date,
            default: null,
        },
        finishedAt: {
            type: Date,
            default: null,
        },
    },
    { timestamps: true }
);


jobSchema.index({ owner: 1, createdAt: -1 });

jobSchema.index({ owner: 1, status: 1 });

jobSchema.index({ status: 1 });

export { JOB_TYPES, JOB_STATUSES };
export const Job = mongoose.model("Job", jobSchema);