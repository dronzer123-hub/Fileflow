import mongoose, { Schema } from "mongoose";

const DATA_TYPES = ["text", "number", "date", "currency", "boolean"];
const CATEGORIES = ["tax", "payment", "shipping", "party", "reference", "other"];

const fieldDefinitionSchema = new Schema(
    {
        key: {
            type: String,
            required: [true, "Key is required."],
            unique: true, // also creates the index
            lowercase: true,
            trim: true,
            maxlength: 40,
            match: [/^[a-z][a-z0-9_]*$/, "Key must be a safe lowercase identifier."],
        },
        displayLabel: {
            type: String,
            required: [true, "Display label is required."],
            trim: true,
            maxlength: 100,
        },
        dataType: {
            type: String,
            enum: DATA_TYPES,
            default: "text",
        },
        category: {
            type: String,
            enum: CATEGORIES,
            default: "other",
        },
        
        synonyms: {
            type: [{ type: String, lowercase: true, trim: true, maxlength: 100 }],
            default: [],
            validate: {
                validator: (arr) => arr.length <= 30,
                message: "A field can have at most 30 synonyms.",
            },
        },
        isActive: {
            type: Boolean,
            default: true, 
        },
    },
    { timestamps: true }
);


fieldDefinitionSchema.pre("validate", function () {
    const all = [...this.synonyms, this.displayLabel?.toLowerCase().trim()];
    this.synonyms = [...new Set(all.filter(Boolean))];
});

export { DATA_TYPES, CATEGORIES };
export const FieldDefinition = mongoose.model("FieldDefinition", fieldDefinitionSchema);