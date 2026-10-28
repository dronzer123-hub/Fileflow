import "dotenv/config";
import mongoose from "mongoose";
import { FieldDefinition } from "../models/FieldDefinition.js";

// Keep synonyms specific. A very generic label like "bank" or "terms"
// would match the wrong lines on real invoices.
const STARTER_FIELDS = [
    {
        key: "tax_id",
        displayLabel: "Tax identification number",
        dataType: "text",
        category: "tax",
        synonyms: [
            "tax id", "tax identification number", "tax registration number",
            "vat number", "vat no", "gstin", "gst no", "gst number",
            "gst identification number", "gstin/uin",
        ],
    },
    {
        key: "pan",
        displayLabel: "PAN",
        dataType: "text",
        category: "tax",
        synonyms: ["pan", "pan no", "pan number", "permanent account number"],
    },
    {
        key: "purchase_order_number",
        displayLabel: "Purchase order number",
        dataType: "text",
        category: "reference",
        synonyms: [
            "po number", "po no", "po #", "po ref", "purchase order",
            "purchase order number", "purchase order no",
        ],
    },
    {
        key: "due_date",
        displayLabel: "Due date",
        dataType: "date",
        category: "payment",
        synonyms: ["due date", "payment due", "payment due date", "due on", "pay by", "date due"],
    },
    {
        key: "payment_terms",
        displayLabel: "Payment terms",
        dataType: "text",
        category: "payment",
        synonyms: ["payment terms", "terms of payment", "credit terms", "payment term"],
    },
    {
        key: "subtotal",
        displayLabel: "Subtotal",
        dataType: "currency",
        category: "payment",
        synonyms: [
            "subtotal", "sub total", "sub-total", "taxable value",
            "taxable amount", "net amount", "total before tax",
        ],
    },
    {
        key: "discount",
        displayLabel: "Discount",
        dataType: "currency",
        category: "payment",
        synonyms: ["discount", "total discount", "discount amount", "less discount"],
    },
    {
        key: "cgst",
        displayLabel: "CGST",
        dataType: "currency",
        category: "tax",
        synonyms: ["cgst", "central gst", "cgst amount", "central tax"],
    },
    {
        key: "sgst",
        displayLabel: "SGST",
        dataType: "currency",
        category: "tax",
        synonyms: ["sgst", "state gst", "sgst amount", "state tax"],
    },
    {
        key: "igst",
        displayLabel: "IGST",
        dataType: "currency",
        category: "tax",
        synonyms: ["igst", "integrated gst", "igst amount", "integrated tax"],
    },
    {
        key: "shipping_charges",
        displayLabel: "Shipping charges",
        dataType: "currency",
        category: "shipping",
        synonyms: [
            "shipping charges", "freight", "freight charges", "delivery charges",
            "shipping and handling", "postage",
        ],
    },
    {
        key: "place_of_supply",
        displayLabel: "Place of supply",
        dataType: "text",
        category: "tax",
        synonyms: ["place of supply", "state of supply", "supply place"],
    },
    {
        key: "bill_to_address",
        displayLabel: "Bill-to address",
        dataType: "text",
        category: "party",
        synonyms: ["bill to", "billed to", "billing address", "invoice to", "sold to"],
    },
    {
        key: "ship_to_address",
        displayLabel: "Ship-to address",
        dataType: "text",
        category: "shipping",
        synonyms: [
            "ship to", "shipped to", "shipping address", "delivery address",
            "deliver to", "consignee",
        ],
    },
    {
        key: "bank_name",
        displayLabel: "Bank name",
        dataType: "text",
        category: "payment",
        synonyms: ["bank name", "name of bank", "banker"],
    },
    {
        key: "ifsc_code",
        displayLabel: "IFSC code",
        dataType: "text",
        category: "payment",
        synonyms: ["ifsc", "ifsc code", "ifs code", "ifsc no"],
    },
];

const cleanList = (list) => [
    ...new Set(list.map((s) => s.toLowerCase().trim()).filter(Boolean)),
];

const run = async () => {
    if (!process.env.MONGODB_URI) {
        throw new Error("MONGODB_URI is not set. Run this from the server folder with a .env file.");
    }
    await mongoose.connect(process.env.MONGODB_URI);

    const operations = STARTER_FIELDS.map((field) => ({
        updateOne: {
            filter: { key: field.key },
            update: {
                // Only applied when the definition is first created,
                // so admin edits made later are never overwritten
                $setOnInsert: {
                    displayLabel: field.displayLabel,
                    dataType: field.dataType,
                    category: field.category,
                    isActive: true,
                },
                // Adds new synonyms, never removes or duplicates existing ones
                $addToSet: {
                    synonyms: { $each: cleanList([...field.synonyms, field.displayLabel]) },
                },
            },
            upsert: true,
        },
    }));

    const result = await FieldDefinition.bulkWrite(operations);
    console.log(
        `Field definitions: ${result.upsertedCount} created, ` +
        `${result.modifiedCount} updated with new synonyms, ` +
        `${STARTER_FIELDS.length} in the starter list.`
    );
};

run()
    .catch((error) => {
        console.error("Seeding failed:", error.message);
        process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());