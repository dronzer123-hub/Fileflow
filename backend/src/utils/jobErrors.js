import { UnrecoverableError } from "bullmq";

// Throw this for problems that retrying cannot fix: a corrupt or password-protected PDF,
// an unsupported file, a missing file. BullMQ then skips the remaining attempts.
// The message is shown to the user, so write it for them.
export class PermanentJobError extends UnrecoverableError {
    constructor(message) {
        super(message);
        this.name = "PermanentJobError";
    }
}