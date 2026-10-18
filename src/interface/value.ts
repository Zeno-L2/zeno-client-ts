import { Address } from "znn-typescript-sdk";
import { ZenoCodecError, ZenoReader, ZenoWriter } from "../codec.js";
import type { Value } from "./types.js";
import { show } from "../format.js";

/** A type the encoding has no wire form for. */
export class UnsupportedTypeError extends Error {
    constructor(public readonly type: string) {
        super(`type ${show(type)} has no encoding in the canonical codec`);
        this.name = "UnsupportedTypeError";
    }
}

export type TypeSpec =
    | { kind: "uint"; bits: 8 | 16 | 32 | 64 | 128 | 256 }
    | { kind: "int"; bits: 8 | 16 | 32 | 64 | 128 }
    | { kind: "bool" }
    | { kind: "bytes" }
    | { kind: "bytesN"; length: number }
    | { kind: "string" }
    | { kind: "hash" }
    | { kind: "l1Address" }
    | { kind: "list"; element: TypeSpec }
    | { kind: "tuple"; elements: TypeSpec[] };

/**
 * Parses the shared type vocabulary: `u8` to `u256`, `i8` to `i128`,
 * `bool`, `bytes`, `bytesN`, `string`, `hash`, `l1Address`, `list<T>`
 * and the tuple `(T, U)`. Anything else, including `i256`, throws
 * `UnsupportedTypeError`.
 */
export function parseType(text: string): TypeSpec {
    return parseTypeAt(text, 0);
}

/** The deepest list and tuple nesting a type can have. */
const MAX_TYPE_DEPTH = 32;

function parseTypeAt(text: string, depth: number): TypeSpec {
    const type = text.trim();
    if (depth > MAX_TYPE_DEPTH) throw new UnsupportedTypeError(type);
    const uint = /^u(8|16|32|64|128|256)$/.exec(type);
    if (uint) return { kind: "uint", bits: Number(uint[1]) as 8 | 16 | 32 | 64 | 128 | 256 };
    const int = /^i(8|16|32|64|128)$/.exec(type);
    if (int) return { kind: "int", bits: Number(int[1]) as 8 | 16 | 32 | 64 | 128 };
    if (type === "bool" || type === "bytes" || type === "string" || type === "hash" || type === "l1Address") {
        return { kind: type };
    }
    const fixed = /^bytes(\d+)$/.exec(type);
    if (fixed) {
        const length = Number(fixed[1]);
        if (length < 1 || length > 32) throw new UnsupportedTypeError(type);
        return { kind: "bytesN", length };
    }
    const list = /^list<(.+)>$/.exec(type);
    if (list) return { kind: "list", element: parseTypeAt(list[1], depth + 1) };
    const tuple = /^\((.*)\)$/.exec(type);
    if (tuple) {
        if (tuple[1].trim() === "") throw new UnsupportedTypeError(type);
        return { kind: "tuple", elements: splitTop(tuple[1]).map((t) => parseTypeAt(t, depth + 1)) };
    }
    throw new UnsupportedTypeError(type);
}

function splitTop(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === "<" || text[i] === "(") depth++;
        else if (text[i] === ">" || text[i] === ")") depth--;
        else if (text[i] === "," && depth === 0) {
            parts.push(text.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(text.slice(start));
    return parts;
}

const hexBytes = (value: string, what: string): Uint8Array => {
    const hex = value.replace(/^0x/i, "");
    if (!/^([0-9a-fA-F]{2})*$/.test(hex)) throw new ZenoCodecError(`${show(what)} is not hex`);
    return Uint8Array.from(Buffer.from(hex, "hex"));
};

function parseAddress(value: string, what: string): Uint8Array {
    try {
        return Address.parse(value).getBytes();
    } catch {
        throw new ZenoCodecError(`${show(what)} is not an L1 address`);
    }
}

function asBytes(value: Value, what: string): Uint8Array {
    if (value instanceof Uint8Array) return value;
    if (typeof value === "string") return hexBytes(value, what);
    throw new ZenoCodecError(`${show(what)} must be bytes or a hex string`);
}

function asInt(value: Value, what: string): bigint {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
    if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
    throw new ZenoCodecError(`${show(what)} must be an integer`);
}

/** Writes `value` as `spec` into `writer`. */
export function encodeValue(writer: ZenoWriter, spec: TypeSpec, value: Value, what = "value"): void {
    switch (spec.kind) {
        case "uint": {
            const n = asInt(value, what);
            if (spec.bits === 8) writer.u8(Number(n));
            else if (spec.bits === 16) writer.u16(Number(n));
            else if (spec.bits === 32) writer.u32(Number(n));
            else if (spec.bits === 64) writer.u64(n);
            else if (spec.bits === 128) writer.u128(n);
            else writer.u256(n);
            return;
        }
        case "int": {
            const n = asInt(value, what);
            if (spec.bits === 8) writer.i8(Number(n));
            else if (spec.bits === 16) writer.i16(Number(n));
            else if (spec.bits === 32) writer.i32(Number(n));
            else if (spec.bits === 64) writer.i64(n);
            else writer.i128(n);
            return;
        }
        case "bool":
            if (typeof value !== "boolean") throw new ZenoCodecError(`${show(what)} must be a boolean`);
            writer.u8(value ? 1 : 0);
            return;
        case "bytes":
            writer.bytes(asBytes(value, what));
            return;
        case "bytesN":
            writer.fixed(asBytes(value, what), spec.length);
            return;
        case "string":
            if (typeof value !== "string") throw new ZenoCodecError(`${show(what)} must be a string`);
            writer.bytes(new TextEncoder().encode(value));
            return;
        case "hash":
            writer.bytes32(asBytes(value, what));
            return;
        case "l1Address":
            if (typeof value !== "string") throw new ZenoCodecError(`${show(what)} must be an address string`);
            writer.address(parseAddress(value, what));
            return;
        case "list": {
            if (!Array.isArray(value)) throw new ZenoCodecError(`${show(what)} must be a list`);
            writer.u32(value.length);
            value.forEach((item, i) => encodeValue(writer, spec.element, item, `${what}[${i}]`));
            return;
        }
        case "tuple": {
            if (!Array.isArray(value) || value.length !== spec.elements.length) {
                throw new ZenoCodecError(`${show(what)} must be a tuple of ${show(spec.elements.length)} values`);
            }
            spec.elements.forEach((element, i) => encodeValue(writer, element, value[i], `${what}.${i}`));
            return;
        }
    }
}

/** Reads one `spec` value. Integers up to 32 bits are numbers, 64 bits and wider are bigints. */
export function decodeValue(reader: ZenoReader, spec: TypeSpec): Value {
    switch (spec.kind) {
        case "uint":
            if (spec.bits === 8) return reader.u8();
            if (spec.bits === 16) return reader.u16();
            if (spec.bits === 32) return reader.u32();
            if (spec.bits === 64) return reader.u64();
            if (spec.bits === 128) return reader.u128();
            return reader.u256();
        case "int":
            if (spec.bits === 8) return reader.i8();
            if (spec.bits === 16) return reader.i16();
            if (spec.bits === 32) return reader.i32();
            if (spec.bits === 64) return reader.i64();
            return reader.i128();
        case "bool": {
            const b = reader.u8();
            if (b > 1) throw new ZenoCodecError(`bool byte ${show(b)} is not 0 or 1`);
            return b === 1;
        }
        case "bytes":
            return reader.bytes();
        case "bytesN":
            return reader.fixed(spec.length);
        case "string":
            try {
                return new TextDecoder("utf-8", { fatal: true }).decode(reader.bytes());
            } catch (error) {
                if (error instanceof ZenoCodecError) throw error;
                throw new ZenoCodecError("a string is not valid UTF-8");
            }
        case "hash":
            return Buffer.from(reader.bytes32()).toString("hex");
        case "l1Address":
            return Address.fromCore(Buffer.from(reader.address())).toString();
        case "list": {
            const count = reader.u32();
            const out: Value[] = [];
            for (let i = 0; i < count; i++) out.push(decodeValue(reader, spec.element));
            return out;
        }
        case "tuple":
            return spec.elements.map((element) => decodeValue(reader, element));
    }
}

/** Encodes `values` in order as the types of `params`. */
export function encodeParams(params: { name: string; type: string }[], values: Value[]): Uint8Array {
    if (values.length !== params.length) {
        throw new ZenoCodecError(`expected ${show(params.length)} arguments, got ${show(values.length)}`);
    }
    const writer = new ZenoWriter();
    params.forEach((p, i) => encodeValue(writer, parseType(p.type), values[i], p.name));
    return writer.finish();
}

/** Sets an own property, so no field name reaches the prototype setter. */
export function setField(record: Record<string, Value>, name: string, value: Value): void {
    Object.defineProperty(record, name, { value, enumerable: true, writable: true, configurable: true });
}

/** Decodes `data` as the types of `params` and rejects trailing bytes. */
export function decodeParams(params: { name: string; type: string }[], data: Uint8Array): Record<string, Value> {
    const reader = new ZenoReader(data);
    const out: Record<string, Value> = {};
    for (const p of params) setField(out, p.name, decodeValue(reader, parseType(p.type)));
    reader.end();
    return out;
}
