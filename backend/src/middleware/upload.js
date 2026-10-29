import fs from "fs";
import path from "path";
import crypto from "crypto";
import multer from "multer";
import { ApiError } from "../utils/ApiError.js";

import { UPLOAD_DIR } from "../services/storage.service.js"
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB) || 10;

// Allowed mime types and the extension we will use for each.
// The extension comes from this table, never from the client's file name.
export const ALLOWED_FILE_TYPES = {
    "application/pdf": ".pdf",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "text/csv": ".csv",
    "application/vnd.ms-excel": ".csv", // Windows browsers often label CSV files this way
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
};

// Create the folder once at startup if it is missing
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const extension = ALLOWED_FILE_TYPES[file.mimetype] ?? "";
        cb(null, `${crypto.randomUUID()}${extension}`);
    },
});

const fileFilter = (req, file, cb) => {
    if (!ALLOWED_FILE_TYPES[file.mimetype]) {
        return cb(
            ApiError.badRequest("Unsupported file type. Upload a PDF, PNG, JPEG, CSV or XLSX file.")
        );
    }
    cb(null, true);
};

const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: MAX_FILE_SIZE_MB * 1024 * 1024,
        files: 1,
        fields: 10,
    },
});

// Expects one file in a form-data field named "file"
export const uploadSingle = upload.single("file");
export { UPLOAD_DIR, MAX_FILE_SIZE_MB };