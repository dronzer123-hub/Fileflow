import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { ApiError } from "../utils/ApiError.js";
import { logger } from "../utils/logger.js";

export const UPLOAD_DIR = path.resolve(process.cwd(), process.env.UPLOAD_DIR || "uploads");

// Make sure the folder exists (safe to call many times)
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Turns a storage key into a full path, and refuses anything that could
// point outside the uploads folder (for example "../.env").
const resolveSafePath = (storagePath) => {
    const key = String(storagePath ?? "");
    const fullPath = path.join(UPLOAD_DIR, path.basename(key));

    if (!key || key !== path.basename(key) || !fullPath.startsWith(UPLOAD_DIR + path.sep)) {
        throw ApiError.badRequest("Invalid file reference.");
    }
    return fullPath;
};

// Called right after Multer has written the file to disk.
// Returns the values the Job document needs. For cloud storage this is where
// you would upload req.file.path to the bucket and delete the local copy.
export const saveFile = async (file) => ({
    storedName: file.filename,
    storagePath: file.filename, // a key inside the upload folder, never an absolute path
    sizeBytes: file.size,
});

export const fileExists = async (storagePath) => {
    try {
        await fsp.access(resolveSafePath(storagePath), fs.constants.R_OK);
        return true;
    } catch {
        return false;
    }
};

// Returns a path on local disk that processing code can read.
// For cloud storage this would download the object to a temp file and return that path.
export const getFilePath = async (storagePath) => {
    const fullPath = resolveSafePath(storagePath);
    if (!(await fileExists(storagePath))) throw ApiError.notFound("File not found.");
    return fullPath;
};

// For the download route: returns a readable stream to pipe into the response
export const getFileStream = async (storagePath) => {
    const fullPath = await getFilePath(storagePath);
    return fs.createReadStream(fullPath);
};

// Returns true if a file was removed. A missing file is not an error:
// deleting a job must still succeed when its file is already gone.
export const deleteFile = async (storagePath) => {
    try {
        await fsp.unlink(resolveSafePath(storagePath));
        return true;
    } catch (error) {
        if (error.code !== "ENOENT") {
            logger.error({ err: error, storagePath }, "Failed to delete stored file");
        }
        return false;
    }
};