import mongoose, { Schema } from "mongoose";

const MAX_EXTRA_FIELDS = 50;
const MAX_LINE_ITEMS = 200;
const VALUE_TYPES = ["text", "number", "date", "currency", "boolean"];
const EXTRACTION_METHODS = ["text", "ocr", "hybrid", "ai"];
const CHANGE_TYPES = ["edited", "added", "removed"];

const confidence = { type: Number, min: 0, max: 1 };

// One extra field found on an invoice
const extraFieldSchema = new Schema(
  {
    key: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 40,
      match: [/^[a-z][a-z0-9_]*$/, "Key must be a safe lowercase identifier."],
    },
    label: { type: String, required: true, trim: true, maxlength: 100 }, // exactly as printed
    value: { type: String, required: true, trim: true, maxlength: 500 },
    parsedValue: { type: Schema.Types.Mixed, default: null }, // typed value if conversion worked
    valueType: { type: String, enum: VALUE_TYPES, default: "text" },
    confidence,
    isKnown: { type: Boolean, default: false }, // matches a FieldDefinition
    source: {
      page: { type: Number, min: 1 },
      origin: { type: String, enum: ["text", "ocr"] },
    },
    edited: { type: Boolean, default: false },
  },
  { _id: false },
);

// One row of the invoice table
const lineItemSchema = new Schema(
  {
    description: { type: String, trim: true, maxlength: 300 },
    quantity: { type: Number },
    unitPrice: { type: Number },
    amount: { type: Number },
    // columns only some invoices have, e.g. { hsnCode: "8471", taxRate: 18 }
    extraColumns: { type: Schema.Types.Mixed, default: undefined },
  },
  { _id: false },
);

const ocrInfoSchema = new Schema(
  {
    pagesProcessed: { type: Number, min: 0 },
    averageConfidence: confidence, // store normalized to 0..1
    language: { type: String, trim: true },
    durationMs: { type: Number, min: 0 },
  },
  { _id: false },
);

const correctionSchema = new Schema(
  {
    field: { type: String, required: true }, // e.g. "totalAmount" or "extraFields.gstin"
    oldValue: { type: Schema.Types.Mixed, default: null },
    newValue: { type: Schema.Types.Mixed, default: null },
    changeType: { type: String, enum: CHANGE_TYPES, required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const extractionResultSchema = new Schema(
  {
    job: {
      type: Schema.Types.ObjectId,
      ref: "Job",
      required: true,
      unique: true, // one result per job (also creates the index)
    },

    // Core fields: optional, because extraction may fail to find them
    // (the validator then sends the job to needs_review)
    invoiceNumber: { type: String, trim: true, maxlength: 60 },
    invoiceDate: { type: Date },
    vendorName: { type: String, trim: true, maxlength: 200 },
    totalAmount: { type: Number, min: 0 },
    currency: {
      type: String,
      uppercase: true,
      trim: true,
      match: [/^[A-Z]{3}$/, "Currency must be a 3-letter code."],
    },

    extraFields: {
      type: [extraFieldSchema],
      validate: {
        validator: (arr) => arr.length <= MAX_EXTRA_FIELDS,
        message: `An invoice can have at most ${MAX_EXTRA_FIELDS} extra fields.`,
      },
    },
    lineItems: {
      type: [lineItemSchema],
      validate: {
        validator: (arr) => arr.length <= MAX_LINE_ITEMS,
        message: `An invoice can have at most ${MAX_LINE_ITEMS} line items.`,
      },
    },

    // How it was extracted and how sure we are
    extractionMethod: {
      type: String,
      enum: EXTRACTION_METHODS,
      default: "text",
    },
    parserUsed: { type: String, trim: true },
    confidence, // overall
    fieldConfidence: {
      invoiceNumber: confidence,
      invoiceDate: confidence,
      vendorName: confidence,
      totalAmount: confidence,
      currency: confidence,
    },
    rawText: {
      type: String,
      maxlength: 200000,
      select: false, // large and private: load it only when asked
    },
    ocrInfo: { type: ocrInfoSchema, default: undefined }, // absent when OCR was not used

    validationErrors: { type: [String], default: [] },

    // Human review
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
    corrections: { type: [correctionSchema], default: [] },
  },
  { timestamps: true, minimize: false },
);

export { VALUE_TYPES, EXTRACTION_METHODS, CHANGE_TYPES, MAX_EXTRA_FIELDS };
export const ExtractionResult = mongoose.model(
  "ExtractionResult",
  extractionResultSchema,
);
