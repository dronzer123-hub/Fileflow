import { z } from "zod";

const emailField = z
    .string({ required_error: "Email is required." })
    .trim()
    .toLowerCase()
    .max(254, "Email is too long.")
    .email("Enter a valid email address.");

const registerPassword = z
    .string({ required_error: "Password is required." })
    .min(8, "Password must be at least 8 characters.")
    .max(72, "Password must be at most 72 characters.")
    .regex(/[a-z]/, "Password must contain a lowercase letter.")
    .regex(/[A-Z]/, "Password must contain an uppercase letter.")
    .regex(/[0-9]/, "Password must contain a number.");

export const registerSchema = z
    .object({
        name: z
            .string({ required_error: "Name is required." })
            .trim()
            .min(2, "Name must be at least 2 characters.")
            .max(50, "Name must be at most 50 characters."),
        email: emailField,
        password: registerPassword,
    })
   
    .strict();

export const loginSchema = z
    .object({
        email: emailField,
       
        password: z
            .string({ required_error: "Password is required." })
            .min(1, "Password is required.")
            .max(72, "Invalid credentials."),
    })
    .strict();