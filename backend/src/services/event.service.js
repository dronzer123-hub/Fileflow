import { JobEvent } from "../models/JobEvent.js";
import { logger } from "../utils/logger.js";

const MAX_MESSAGE_LENGTH = 500; // matches the maxlength in the JobEvent model
const MAX_METADATA_CHARS = 4000;

// Keeps metadata small, plain and safe to store
const cleanMetadata = (metadata) => {
    if (metadata === undefined || metadata === null) return {};

    try {
        // The JSON round trip drops functions and undefined values and turns dates into strings
        const json = JSON.stringify(metadata);
        if (json.length > MAX_METADATA_CHARS) {
            return { truncated: true, note: "Metadata was too large to store." };
        }
        const plain = JSON.parse(json);
        return typeof plain === "object" && !Array.isArray(plain) ? plain : { value: plain };
    } catch {
        return { truncated: true, note: "Metadata could not be stored." };
    }
};

/**
 * Adds one entry to a job's history.
 * Never throws: a failed history write must not break upload or processing.
 * Returns the saved event, or null if saving failed.
 */
export const recordEvent = async (jobId, type, message, metadata = {}) => {
    try {
        return await JobEvent.create({
            job: jobId,
            type,
            message: String(message ?? "").slice(0, MAX_MESSAGE_LENGTH),
            metadata: cleanMetadata(metadata),
        });
    } catch (error) {
        logger.error({ err: error, jobId, type }, "Failed to record job event");
        return null;
    }
};