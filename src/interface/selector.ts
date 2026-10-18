import { hexToBytes } from "../bytes.js";
import { ZenoCodecError, ZenoReader, ZenoWriter } from "../codec.js";
import { sha3 } from "../derive.js";
import type { ContractInterface, DecodedError, DecodedEvent, InterfaceEncoder, MethodDef, StorageDef, Value } from "./types.js";
import { decodeParams, decodeValue, encodeParams, encodeValue, parseType, setField } from "./value.js";
import { show } from "../format.js";

/** The encoding of `contract-sdk.md` D-6 to D-8. */
export const ZENO_SELECTOR_V1 = "zeno-selector-v1";

const utf8 = (text: string) => new TextEncoder().encode(text);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** The first four bytes of `SHA3-256(method_name)`. */
export function selectorOf(name: string): Uint8Array {
    return sha3(utf8(name)).slice(0, 4);
}

function method(iface: ContractInterface, name: string): MethodDef {
    const found = iface.methods.find((m) => m.name === name);
    if (!found) throw new ZenoCodecError(`the interface has no method ${show(name)}`);
    return found;
}

function storage(iface: ContractInterface, name: string): StorageDef {
    const found = iface.storage.find((s) => s.name === name);
    if (!found) throw new ZenoCodecError(`the interface has no storage entry ${show(name)}`);
    return found;
}

export const zenoSelectorV1: InterfaceEncoder = {
    encoding: ZENO_SELECTOR_V1,

    encodeCall(iface, name, args) {
        const def = method(iface, name);
        const body = encodeParams(def.inputs, args);
        const payload = new Uint8Array(4 + body.length);
        payload.set(selectorOf(name), 0);
        payload.set(body, 4);
        return payload;
    },

    decodeReturn(iface, name, returnData) {
        return decodeParams(method(iface, name).outputs, returnData);
    },

    decodeError(iface, abortCode, revertData): DecodedError {
        const def = iface.errors.find((e) => e.code === abortCode);
        if (def) return { code: abortCode, name: def.name, fields: decodeParams(def.fields, revertData) };
        if (abortCode < 0) return { code: abortCode, name: `SDK failure ${abortCode}`, fields: {} };
        return { code: abortCode, name: `unknown error ${abortCode}`, fields: {} };
    },

    decodeEvent(iface, topics, data): DecodedEvent | null {
        if (!Array.isArray(topics)) throw new ZenoCodecError("the event topics are not a list");
        if (topics.length === 0) return null;
        if (typeof topics[0] !== "string") throw new ZenoCodecError("the event signature topic is not a string");
        const def = iface.events.find((e) => e.topic.toLowerCase() === topics[0].toLowerCase());
        if (!def) return null;
        const indexedCount = def.fields.filter((f) => f.indexed).length;
        if (topics.length !== 1 + indexedCount) {
            throw new ZenoCodecError(`event ${show(def.name)} has ${show(indexedCount)} indexed fields but got ${show(topics.length - 1)} field topics`);
        }
        const reader = new ZenoReader(data);
        const fields: Record<string, Value> = {};
        let next = 1;
        for (const field of def.fields) {
            const spec = parseType(field.type);
            if (field.indexed) {
                const topicReader = new ZenoReader(hexToBytes(topics[next++], "an event topic", (detail) => new ZenoCodecError(detail)));
                setField(fields, field.name, decodeValue(topicReader, spec));
                topicReader.end();
            } else {
                setField(fields, field.name, decodeValue(reader, spec));
            }
        }
        reader.end();
        return { name: def.name, fields };
    },

    storageKey(iface, name, key = []) {
        const def = storage(iface, name);
        if (key.length !== def.key.length) {
            throw new ZenoCodecError(`${show(name)} takes ${show(def.key.length)} key values, got ${show(key.length)}`);
        }
        const writer = new ZenoWriter().u8(parseInt(def.namespace.slice(2), 16));
        def.key.forEach((field, i) => encodeValue(writer, parseType(field.type), key[i], field.name));
        const local = writer.finish();
        return def.hashed ? sha3(local) : local;
    },

    decodeStorageValue(iface, name, value) {
        const def = storage(iface, name);
        const reader = new ZenoReader(value);
        const decoded = decodeValue(reader, parseType(def.value));
        reader.end();
        return decoded;
    },
};

export const selectorHex = (name: string) => hex(selectorOf(name));
export type { Value };
