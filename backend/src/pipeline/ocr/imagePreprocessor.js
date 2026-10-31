import path from "node:path";
import sharp from "sharp";
import { ocrConfig } from "../../config/ocr.js";
import { PermanentJobError } from "../../utils/jobErrors.js";

// sharp keeps files open in its cache; on Windows that blocks deleting the temp folder (EBUSY)
sharp.cache(false);

const MAX_ENLARGE = 4; // never magnify more than 4x: beyond that it is just a bigger blur
const MAX_INPUT_PIXELS = 100_000_000; // refuse decompression bombs (about 10000 x 10000)

/**
 * Prepares one image for OCR. The ORIGINAL IS NEVER TOUCHED: the result is a new PNG in outputDir.
 *
 *   inputPath   an uploaded image or a page image from pdfToImages
 *   outputDir   the job's temp folder (from withTempDir)
 *   name        base name for the output file, e.g. "page-001" (default: the input's name)
 *   options     defaults to ocrConfig.preprocess; pass your own in tests
 *
 * Returns { path, steps, width, height }. `steps` is a readable list for the event timeline.
 */
export const preprocessImage = async ({ inputPath, outputDir, name, options = ocrConfig.preprocess }) => {
    const baseName = name ?? path.parse(inputPath).name;
    const outputPath = path.join(outputDir, `pre-${baseName}.png`);

    // Hard guard: the output must be a different file, inside the temp folder
    if (path.resolve(outputPath) === path.resolve(inputPath) || path.dirname(path.resolve(outputPath)) !== path.resolve(outputDir)) {
        throw new Error("Preprocessed image must be written to a new file inside the job's temp folder.");
    }

    const steps = [];

    try {
        const source = sharp(inputPath, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
        const meta = await source.metadata();
        if (!meta.width || !meta.height) throw new PermanentJobError("This image has no readable size.");

        // EXIF orientations 5-8 are the sideways ones: width and height swap after auto-rotation
        const sideways = (meta.orientation ?? 1) >= 5;
        const width = sideways ? meta.height : meta.width;

        let pipeline = source.rotate(); // no argument = apply the EXIF orientation, then drop the tag
        if ((meta.orientation ?? 1) > 1) steps.push(`auto-rotate (EXIF orientation ${meta.orientation})`);

        // Transparent PNGs would turn black text on a transparent background into a black page
        if (meta.hasAlpha) {
            pipeline = pipeline.flatten({ background: "#ffffff" });
            steps.push("flatten transparency onto white");
        }

        // Resize first: shrinking early makes every later step cheaper
        if (width < options.minWidth) {
            const target = Math.min(options.targetWidth, width * MAX_ENLARGE);
            pipeline = pipeline.resize({ width: Math.round(target), kernel: "lanczos3" });
            steps.push(`enlarge ${width}px -> ${Math.round(target)}px wide`);
        } else if (width > options.maxWidth) {
            pipeline = pipeline.resize({ width: options.maxWidth, kernel: "lanczos3" });
            steps.push(`shrink ${width}px -> ${options.maxWidth}px wide`);
        }

        pipeline = pipeline.greyscale();
        steps.push("grayscale");

        if (options.denoise) {
            pipeline = pipeline.median(3);
            steps.push("denoise (median filter)");
        }

        pipeline = pipeline.normalise({ lower: 1, upper: 99 }); // stretch contrast, ignoring the extreme 1% at each end
        steps.push("stretch contrast");

        if (options.sharpen) {
            pipeline = pipeline.sharpen({ sigma: 1 });
            steps.push("sharpen");
        }

        if (options.threshold) {
            pipeline = pipeline.threshold(options.thresholdLevel);
            steps.push(`threshold at ${options.thresholdLevel} (pure black and white)`);
        }

        const info = await pipeline.png({ compressionLevel: 6 }).toFile(outputPath);
        return { path: outputPath, steps, width: info.width, height: info.height };
    } catch (error) {
        if (error instanceof PermanentJobError) throw error;
        // Bad image data is permanent. A missing file is NOT: that is a storage problem, so it stays temporary.
        if (/unsupported image format|corrupt|truncated|bad seek|invalid|pixel limit|too large/i.test(error.message)) {
            throw new PermanentJobError("This image is damaged, too large or in an unsupported format.");
        }
        throw error; // unexpected: let the processor treat it as temporary
    }
};