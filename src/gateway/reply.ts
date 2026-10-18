import { bounded, show } from "../format.js";

/**
 * The error a JSON-RPC reply carries, or null when it carries none. Both
 * transports use this so one reply means the same over either. The
 * message is bounded and cannot throw, whatever the gateway sent.
 */
export function replyError(reply: { error?: unknown }): (Error & { code?: unknown; data?: unknown }) | null {
    const error = reply.error;
    if (error === undefined || error === null) return null;
    if (typeof error !== "object") return new Error(show(error));
    const fields = error as { code?: unknown; message?: unknown; data?: unknown };
    const message = fields.message === undefined ? "gateway error" : typeof fields.message === "string" ? bounded(fields.message) : bounded(show(fields.message));
    return Object.assign(new Error(message), { code: fields.code, data: fields.data });
}
