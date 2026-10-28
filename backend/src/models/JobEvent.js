import mongoose, { Schema } from "mongoose";

const EVENT_TYPES = [
    "uploaded",
    "queued",
    "started",
    "text_extracted",
    "ocr_used",
    "fields_extracted",
    "validation_failed",
    "retried",
    "completed",
    "failed",
    "reviewed",
];

const jobEventSchema = new Schema(
    {
        job: {
            type: Schema.Types.ObjectId,
            ref: "Job",
            required: true,
        },
        type: {
            type: String,
            enum: EVENT_TYPES,
            required: true,
        },
        message: {
            type: String,
            required: true,
            trim: true,
            maxlength: 500,
        },
        
        metadata: {
            type: Schema.Types.Mixed,
            default: {},
        },
    },
    {
        
        timestamps: { createdAt: true, updatedAt: false },
        
        minimize: false,
    }
);


jobEventSchema.index({ job: 1, createdAt: 1 });


const blockUpdate = function () {
    throw new Error("JobEvent is append-only and cannot be updated.");
};

jobEventSchema.pre("save", function () {
    if (!this.isNew) blockUpdate();
});
["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne"].forEach(
    (op) => jobEventSchema.pre(op, blockUpdate)
);

export { EVENT_TYPES };
export const JobEvent = mongoose.model("JobEvent", jobEventSchema);