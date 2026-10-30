import { FieldDefinition } from "../models/FieldDefinition.js";

const CACHE_MS = 5 * 60 * 1000; // refresh every 5 minutes, so new definitions are picked up without a restart

let cache = null;
let loadedAt = 0;

export const getFieldRegistry = async () => {
    if (cache && Date.now() - loadedAt < CACHE_MS) return cache;

    cache = await FieldDefinition.find({ isActive: true }).lean();
    loadedAt = Date.now();
    return cache;
};