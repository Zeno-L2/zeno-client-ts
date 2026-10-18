/** Concatenates byte arrays into one new array. */
export function concat(items: ReadonlyArray<Uint8Array>): Uint8Array {
    const length = items.reduce((total, item) => total + item.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const item of items) {
        result.set(item, offset);
        offset += item.length;
    }
    return result;
}

/**
 * Decodes a hex string. Anything but a string of even-length hex is
 * refused before any allocation, because `Buffer.from` sizes its output
 * from a `length` property on a non-string value.
 */
export function hexToBytes(value: unknown, what: string, error: (detail: string) => Error): Uint8Array {
    if (typeof value !== "string" || !/^(?:[0-9a-fA-F]{2})*$/.test(value)) {
        throw error(`${what} is not even-length hex`);
    }
    return Uint8Array.from(Buffer.from(value, "hex"));
}
