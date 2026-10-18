import { concat } from "./bytes.js";
import { show } from "./format.js";

/** Thrown when canonical-format bytes are malformed. */
export class ZenoCodecError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ZenoCodecError";
    }
}

const U32_MAX = 0xffffffff;
const U64_MAX = 0xffffffffffffffffn;
const U128_MAX = (1n << 128n) - 1n;
const U256_MAX = (1n << 256n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;

function bigToBytes(v: bigint, length: number): Uint8Array {
    const out = new Uint8Array(length);
    let rest = v;
    for (let i = length - 1; i >= 0; i--) {
        out[i] = Number(rest & 0xffn);
        rest >>= 8n;
    }
    return out;
}

function bytesToBig(data: Uint8Array): bigint {
    let v = 0n;
    for (const b of data) {
        v = (v << 8n) | BigInt(b);
    }
    return v;
}

/** A bigint, or an integer number as a bigint. Anything else is a codec error. */
function integer(type: string, value: unknown): bigint {
    if (typeof value === "bigint") return value;
    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new ZenoCodecError(`${type} out of range: ${show(value)}`);
    }
    return BigInt(value);
}

/**
 * Writer for the canonical format of SPEC §14.1 / §27.0: fixed-width
 * big-endian integers, fixed-width hashes, `Bytes` as a `u32` length
 * prefix plus raw bytes and lists as a `u32` count plus elements.
 */
export class ZenoWriter {
    private readonly parts: Uint8Array[] = [];

    private push(bytes: Uint8Array): this {
        this.parts.push(bytes);
        return this;
    }

    u8(value: number): this {
        if (!Number.isInteger(value) || value < 0 || value > 0xff) {
            throw new ZenoCodecError(`u8 out of range: ${show(value)}`);
        }
        return this.push(Uint8Array.of(value));
    }

    u16(value: number): this {
        if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
            throw new ZenoCodecError(`u16 out of range: ${show(value)}`);
        }
        const out = new Uint8Array(2);
        new DataView(out.buffer).setUint16(0, value, false);
        return this.push(out);
    }

    u32(value: number): this {
        if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
            throw new ZenoCodecError(`u32 out of range: ${show(value)}`);
        }
        const out = new Uint8Array(4);
        new DataView(out.buffer).setUint32(0, value, false);
        return this.push(out);
    }

    i32(value: number): this {
        if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
            throw new ZenoCodecError(`i32 out of range: ${show(value)}`);
        }
        const out = new Uint8Array(4);
        new DataView(out.buffer).setInt32(0, value, false);
        return this.push(out);
    }

    u64(value: bigint | number): this {
        const v = integer("u64", value);
        if (v < 0n || v > U64_MAX) {
            throw new ZenoCodecError(`u64 out of range: ${show(value)}`);
        }
        const out = new Uint8Array(8);
        new DataView(out.buffer).setBigUint64(0, v, false);
        return this.push(out);
    }

    i8(value: number): this {
        if (!Number.isInteger(value) || value < -0x80 || value > 0x7f) {
            throw new ZenoCodecError(`i8 out of range: ${show(value)}`);
        }
        const out = new Uint8Array(1);
        new DataView(out.buffer).setInt8(0, value);
        return this.push(out);
    }

    i16(value: number): this {
        if (!Number.isInteger(value) || value < -0x8000 || value > 0x7fff) {
            throw new ZenoCodecError(`i16 out of range: ${show(value)}`);
        }
        const out = new Uint8Array(2);
        new DataView(out.buffer).setInt16(0, value, false);
        return this.push(out);
    }

    i64(value: bigint | number): this {
        const v = integer("i64", value);
        if (v < I64_MIN || v > I64_MAX) {
            throw new ZenoCodecError(`i64 out of range: ${show(value)}`);
        }
        const out = new Uint8Array(8);
        new DataView(out.buffer).setBigInt64(0, v, false);
        return this.push(out);
    }

    u128(value: bigint | number): this {
        const v = integer("u128", value);
        if (v < 0n || v > U128_MAX) {
            throw new ZenoCodecError(`u128 out of range: ${show(value)}`);
        }
        return this.push(bigToBytes(v, 16));
    }

    i128(value: bigint | number): this {
        const v = integer("i128", value);
        if (v < I128_MIN || v > I128_MAX) {
            throw new ZenoCodecError(`i128 out of range: ${show(value)}`);
        }
        return this.push(bigToBytes(BigInt.asUintN(128, v), 16));
    }

    u256(value: bigint | number): this {
        const v = integer("u256", value);
        if (v < 0n || v > U256_MAX) {
            throw new ZenoCodecError(`u256 out of range: ${show(value)}`);
        }
        const out = new Uint8Array(32);
        const view = new DataView(out.buffer);
        for (let i = 0; i < 4; i++) {
            view.setBigUint64(24 - i * 8, (v >> BigInt(64 * i)) & U64_MAX, false);
        }
        return this.push(out);
    }

    /** A fixed-width field such as `bytes32` or `Address`. */
    fixed(bytes: Uint8Array, length: number): this {
        if (bytes.length !== length) {
            throw new ZenoCodecError(`expected ${show(length)} bytes, got ${show(bytes.length)}`);
        }
        return this.push(Uint8Array.from(bytes));
    }

    bytes32(bytes: Uint8Array): this {
        return this.fixed(bytes, 32);
    }

    address(bytes: Uint8Array): this {
        return this.fixed(bytes, 20);
    }

    bytes(bytes: Uint8Array): this {
        this.u32(bytes.length);
        return this.push(Uint8Array.from(bytes));
    }

    list<T>(items: readonly T[], write: (writer: this, item: T) => void): this {
        this.u32(items.length);
        for (const item of items) {
            write(this, item);
        }
        return this;
    }

    /** Raw bytes with no length prefix. */
    raw(bytes: Uint8Array): this {
        return this.push(Uint8Array.from(bytes));
    }

    finish(): Uint8Array {
        return concat(this.parts);
    }
}

/** Reader counterpart of {@link ZenoWriter}. Call {@link end} to reject trailing bytes. */
export class ZenoReader {
    private offset = 0;
    private readonly view: DataView;

    constructor(private readonly data: Uint8Array) {
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    }

    get remaining(): number {
        return this.data.length - this.offset;
    }

    private take(length: number): Uint8Array {
        if (length > this.remaining) {
            throw new ZenoCodecError(`truncated: need ${show(length)} bytes, have ${show(this.remaining)}`);
        }
        const out = this.data.slice(this.offset, this.offset + length);
        this.offset += length;
        return out;
    }

    u8(): number {
        this.ensure(1);
        return this.view.getUint8(this.offset++);
    }

    u16(): number {
        this.ensure(2);
        const v = this.view.getUint16(this.offset, false);
        this.offset += 2;
        return v;
    }

    u32(): number {
        this.ensure(4);
        const v = this.view.getUint32(this.offset, false);
        this.offset += 4;
        return v;
    }

    i32(): number {
        this.ensure(4);
        const v = this.view.getInt32(this.offset, false);
        this.offset += 4;
        return v;
    }

    u64(): bigint {
        this.ensure(8);
        const v = this.view.getBigUint64(this.offset, false);
        this.offset += 8;
        return v;
    }

    i8(): number {
        this.ensure(1);
        return this.view.getInt8(this.offset++);
    }

    i16(): number {
        this.ensure(2);
        const v = this.view.getInt16(this.offset, false);
        this.offset += 2;
        return v;
    }

    i64(): bigint {
        this.ensure(8);
        const v = this.view.getBigInt64(this.offset, false);
        this.offset += 8;
        return v;
    }

    u128(): bigint {
        return bytesToBig(this.take(16));
    }

    i128(): bigint {
        return BigInt.asIntN(128, bytesToBig(this.take(16)));
    }

    u256(): bigint {
        this.ensure(32);
        let v = 0n;
        for (let i = 0; i < 4; i++) {
            v = (v << 64n) | this.view.getBigUint64(this.offset + i * 8, false);
        }
        this.offset += 32;
        return v;
    }

    fixed(length: number): Uint8Array {
        return this.take(length);
    }

    bytes32(): Uint8Array {
        return this.take(32);
    }

    address(): Uint8Array {
        return this.take(20);
    }

    bytes(maxLength = U32_MAX): Uint8Array {
        const length = this.u32();
        if (length > maxLength) {
            throw new ZenoCodecError(`bytes length ${show(length)} exceeds ${show(maxLength)}`);
        }
        return this.take(length);
    }

    list<T>(read: (reader: this) => T, maxCount = U32_MAX): T[] {
        const count = this.u32();
        if (count > maxCount) {
            throw new ZenoCodecError(`list count ${show(count)} exceeds ${show(maxCount)}`);
        }
        const out: T[] = [];
        for (let i = 0; i < count; i++) {
            out.push(read(this));
        }
        return out;
    }

    private ensure(length: number): void {
        if (length > this.remaining) {
            throw new ZenoCodecError(`truncated: need ${show(length)} bytes, have ${show(this.remaining)}`);
        }
    }

    /** Rejects trailing bytes. */
    end(): void {
        if (this.remaining !== 0) {
            throw new ZenoCodecError(`${show(this.remaining)} trailing bytes`);
        }
    }
}
