import { ZenoCodecError } from "../codec.js";
import { sha3 } from "../derive.js";
import { selectorHex } from "./selector.js";
import type { ContractInterface } from "./types.js";
import { UnsupportedTypeError, parseType } from "./value.js";
import type { TypeSpec } from "./value.js";
import { show } from "../format.js";

const isHash = (v: unknown): v is string => typeof v === "string" && /^[0-9a-fA-F]{64}$/.test(v);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

const fail = (path: string, problem: string): never => {
    throw new ZenoCodecError(`${path}: ${problem}`);
};

/** Checks that `value` is a list of objects that each carry a string `name` and `type`. */
function fieldList(value: unknown, path: string): Record<string, unknown>[] {
    if (!Array.isArray(value)) return fail(path, "must be a list");
    const seen = new Set<string>();
    value.forEach((field, j) => {
        if (!isRecord(field)) fail(`${path}[${j}]`, "must be an object");
        const f = field as Record<string, unknown>;
        if (typeof f.name !== "string") fail(`${path}[${j}].name`, "must be a string");
        if (f.name === "__proto__") fail(`${path}[${j}].name`, "reserved name");
        if (seen.has(f.name as string)) fail(`${path}[${j}].name`, `duplicate name ${show(f.name)}`);
        seen.add(f.name as string);
        if (typeof f.type !== "string") fail(`${path}[${j}].type`, "must be a string");
    });
    return value as Record<string, unknown>[];
}

function entryList(value: unknown, path: string): Record<string, unknown>[] {
    if (!Array.isArray(value)) return fail(path, "must be a list");
    value.forEach((entry, i) => {
        if (!isRecord(entry)) fail(`${path}[${i}]`, "must be an object");
    });
    return value as Record<string, unknown>[];
}

function typeOf(text: string, path: string): TypeSpec {
    try {
        return parseType(text);
    } catch (error) {
        if (error instanceof UnsupportedTypeError) return fail(path, error.message);
        throw error;
    }
}

/** The encoded width in bytes of a fixed-width type, or null when the type is variable-length. */
function fixedWidth(spec: TypeSpec): number | null {
    switch (spec.kind) {
        case "uint":
        case "int":
            return spec.bits / 8;
        case "bool":
            return 1;
        case "bytesN":
            return spec.length;
        case "hash":
            return 32;
        case "l1Address":
            return 20;
        case "tuple": {
            let sum = 0;
            for (const element of spec.elements) {
                const width = fixedWidth(element);
                if (width === null) return null;
                sum += width;
            }
            return sum;
        }
        default:
            return null;
    }
}

/**
 * Validates a parsed interface file against the interface_version 1
 * schema. A version this SDK has not seen is rejected. Every problem is
 * reported as `<path>: <problem>`. Unknown members are ignored.
 */
export function parseInterface(json: unknown): ContractInterface {
    if (!isRecord(json)) throw new ZenoCodecError("the interface file is not an object");
    const iface = json;
    if (iface.interface_version !== 1) {
        throw new ZenoCodecError(`interface_version ${show(iface.interface_version)} is not supported`);
    }
    if (typeof iface.encoding !== "string" || iface.encoding === "") throw new ZenoCodecError("the interface names no encoding");
    if (!isHash(iface.code_hash)) throw new ZenoCodecError("code_hash must be 32 bytes of hex");

    for (const list of ["methods", "events", "errors", "storage"] as const) {
        if (!Array.isArray(iface[list])) fail(list, "must be a list");
    }
    const onDeposit = iface.on_deposit;
    if (onDeposit === undefined) fail("on_deposit", "must be present, as null or an object");
    if (onDeposit !== null) {
        if (!isRecord(onDeposit)) fail("on_deposit", "must be null or an object");
        if (typeof (onDeposit as Record<string, unknown>).name !== "string") fail("on_deposit.name", "must be a string");
    }

    const methods = entryList(iface.methods, "methods");
    const events = entryList(iface.events, "events");
    const errors = entryList(iface.errors, "errors");
    const storage = entryList(iface.storage, "storage");
    methods.forEach((m, i) => {
        fieldList(m.inputs, `methods[${i}].inputs`);
        fieldList(m.outputs, `methods[${i}].outputs`);
    });
    if (onDeposit !== null) fieldList((onDeposit as Record<string, unknown>).outputs, "on_deposit.outputs");
    events.forEach((e, i) => {
        if (typeof e.name !== "string") fail(`events[${i}].name`, "must be a string");
        fieldList(e.fields, `events[${i}].fields`);
    });
    errors.forEach((e, i) => {
        if (typeof e.name !== "string") fail(`errors[${i}].name`, "must be a string");
        fieldList(e.fields, `errors[${i}].fields`);
    });
    storage.forEach((s, i) => {
        if (typeof s.name !== "string") fail(`storage[${i}].name`, "must be a string");
        if (typeof s.value !== "string") fail(`storage[${i}].value`, "must be a string");
        fieldList(s.key, `storage[${i}].key`);
    });

    methods.forEach((m, i) => {
        if (typeof m.name !== "string") fail(`methods[${i}].name`, "must be a string");
        if (typeof m.selector !== "string" || m.selector.toLowerCase() !== selectorHex(m.name as string)) {
            fail(`methods[${i}].selector`, "must be the first four bytes of SHA3-256 of the method name");
        }
        if (typeof m.payable !== "boolean") fail(`methods[${i}].payable`, "must be a boolean");
        if (typeof m.readonly !== "boolean") fail(`methods[${i}].readonly`, "must be a boolean");
    });

    events.forEach((e, i) => {
        const expected = hex(sha3(new TextEncoder().encode(e.name as string)));
        if (typeof e.topic !== "string" || e.topic.toLowerCase() !== expected) {
            fail(`events[${i}].topic`, "must be SHA3-256 of the event name");
        }
        const fields = e.fields as Record<string, unknown>[];
        fields.forEach((f, j) => {
            if (typeof f.indexed !== "boolean") fail(`events[${i}].fields[${j}].indexed`, "must be a boolean");
        });
        const indexed = fields.filter((f) => f.indexed === true);
        if (indexed.length > 3) fail(`events[${i}].fields`, "at most 3 fields can be indexed");
        fields.forEach((f, j) => {
            if (f.indexed !== true) return;
            const spec = typeOf(f.type as string, `events[${i}].fields[${j}].type`);
            const ok = spec.kind === "hash" || (spec.kind === "bytesN" && spec.length === 32) || (spec.kind === "uint" && spec.bits === 256);
            if (!ok) fail(`events[${i}].fields[${j}].type`, "an indexed field must be hash, bytes32 or u256");
        });
    });

    errors.forEach((e, i) => {
        const code = e.code;
        if (typeof code !== "number" || !Number.isInteger(code) || code === 0 || code < -0x80000000 || code > 0x7fffffff) {
            fail(`errors[${i}].code`, "must be a non-zero 32-bit integer");
        }
        if (typeof e.description !== "string") fail(`errors[${i}].description`, "must be a string");
    });

    storage.forEach((s, i) => {
        if (s.kind !== "item" && s.kind !== "map") fail(`storage[${i}].kind`, "must be item or map");
        if (typeof s.namespace !== "string" || !/^0x[0-9a-fA-F]{2}$/.test(s.namespace) || /^0x00$/i.test(s.namespace)) {
            fail(`storage[${i}].namespace`, "must be 0x01 to 0xff");
        }
        const keyLength = (s.key as unknown[]).length;
        if (s.kind === "item" && keyLength !== 0) fail(`storage[${i}].key`, "must be empty for an item");
        if (s.kind === "map" && keyLength === 0) fail(`storage[${i}].key`, "must not be empty for a map");
        if (typeof s.hashed !== "boolean") fail(`storage[${i}].hashed`, "must be a boolean");
    });

    const checkFields = (list: Record<string, unknown>[], path: string) => {
        return list.map((f, j) => typeOf(f.type as string, `${path}[${j}].type`));
    };
    methods.forEach((m, i) => {
        checkFields(m.inputs as Record<string, unknown>[], `methods[${i}].inputs`);
        checkFields(m.outputs as Record<string, unknown>[], `methods[${i}].outputs`);
    });
    if (onDeposit !== null) checkFields((onDeposit as Record<string, unknown>).outputs as Record<string, unknown>[], "on_deposit.outputs");
    events.forEach((e, i) => checkFields(e.fields as Record<string, unknown>[], `events[${i}].fields`));
    errors.forEach((e, i) => checkFields(e.fields as Record<string, unknown>[], `errors[${i}].fields`));
    storage.forEach((s, i) => {
        const keySpecs = checkFields(s.key as Record<string, unknown>[], `storage[${i}].key`);
        typeOf(s.value as string, `storage[${i}].value`);
        let variable = false;
        let width = 0;
        for (const spec of keySpecs) {
            const w = fixedWidth(spec);
            if (w === null) variable = true;
            else width += w;
        }
        const mustHash = variable || width > 30;
        if (s.hashed !== mustHash) fail(`storage[${i}].hashed`, `must be ${mustHash} for this key`);
    });

    return json as unknown as ContractInterface;
}
