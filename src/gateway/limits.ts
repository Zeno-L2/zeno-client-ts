import { show } from "../format.js";

/** The largest delay `setTimeout` runs as given. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Throws `RangeError` unless `timeoutMs` is an integer from 1 to 2,147,483,647, the range `setTimeout` honours. */
export function checkTimeout(timeoutMs: number): void {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
        throw new RangeError(`timeoutMs ${show(timeoutMs)} is not an integer from 1 to ${MAX_TIMEOUT_MS}`);
    }
}

/** Throws `RangeError` unless `maxSize` is a number of at least 1, because a comparison with NaN never refuses a response. */
export function checkMaxSize(maxSize: number): void {
    if (typeof maxSize !== "number" || !(maxSize >= 1)) {
        throw new RangeError(`maxResponseSize ${show(maxSize)} is not a number of at least 1`);
    }
}
