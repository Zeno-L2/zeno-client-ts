import { expect } from "chai";
import { sha3_256 } from "@noble/hashes/sha3";
import { Address } from "znn-typescript-sdk";
import {
    UnsupportedEncodingError,
    UnsupportedTypeError,
    decodeParams,
    ZenoCodecError,
    interfaceEncoderFor,
    parseInterface,
    parseType,
    prepareCall,
    prepareDeploy,
    selectorOf,
    sha3,
    zenoSelectorV1,
} from "../src/index.js";
import type { ContractInterface } from "../src/index.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const fromHex = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));
const utf8 = (text: string) => new TextEncoder().encode(text);

const module = fromHex("0061736d01000000deadbeef");
const SHORTFALL_TOPIC = hex(sha3_256(utf8("Deposited")));

// Expected bytes, computed with @noble/hashes sha3_256 and BigInt.asUintN, independent of the SDK.
const EXPECTED = {
    signedVector: "fffffefffffffffffffffdfffffffffffffffffffffffffffffffcffffffffffffffffffffffffffffffff",
};

const method = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    selector: hex(selectorOf(name)),
    payable: false,
    readonly: false,
    inputs: [],
    outputs: [],
    ...extra,
});

// A hand-written interface in the interface_version 1 shape.
const iface: ContractInterface = {
    interface_version: 1,
    encoding: "zeno-selector-v1",
    code_hash: hex(sha3(module)),
    methods: [
        method("add", { inputs: [{ name: "amount", type: "u64" }], outputs: [{ name: "total", type: "u64" }] }),
        method("get", { readonly: true, outputs: [{ name: "total", type: "u64" }] }),
        method("withdraw", {
            inputs: [
                { name: "to", type: "l1Address" },
                { name: "asset", type: "hash" },
                { name: "amount", type: "u256" },
            ],
        }),
        method("label", {
            inputs: [
                { name: "name", type: "string" },
                { name: "flag", type: "bool" },
                { name: "ids", type: "list<u32>" },
                { name: "pair", type: "(u8,bytes4)" },
            ],
        }),
        method("wide", {
            inputs: [
                { name: "a", type: "i8" },
                { name: "b", type: "i16" },
                { name: "c", type: "i64" },
                { name: "d", type: "i128" },
                { name: "e", type: "u128" },
            ],
        }),
        method("stats", {
            readonly: true,
            outputs: [
                { name: "count", type: "u64" },
                { name: "label", type: "string" },
            ],
        }),
    ],
    on_deposit: null,
    events: [
        {
            name: "Deposited",
            topic: SHORTFALL_TOPIC,
            fields: [{ name: "amount", type: "u256", indexed: false }],
        },
    ],
    errors: [
        { code: 1, name: "InsufficientBalance", fields: [{ name: "shortfall", type: "u256" }], description: "The balance is too low." },
        { code: 2, name: "Paused", fields: [], description: "The contract is paused." },
    ],
    storage: [
        { name: "total", kind: "item", namespace: "0x01", key: [], hashed: false, value: "u64" },
        { name: "balances", kind: "map", namespace: "0x02", key: [{ name: "id", type: "u64" }], hashed: false, value: "u256" },
        { name: "blobs", kind: "map", namespace: "0x03", key: [{ name: "data", type: "bytes" }], hashed: true, value: "u8" },
    ],
};

const encoder = zenoSelectorV1;

describe("zeno-selector-v1", () => {
    it("takes the selector from the first four bytes of SHA3-256 of the method name", () => {
        expect(hex(selectorOf("add"))).to.equal(hex(sha3_256(utf8("add")).slice(0, 4)));
        expect(selectorOf("add")).to.have.length(4);
    });

    it("encodes a call as selector then the arguments in the canonical codec", () => {
        const payload = encoder.encodeCall(iface, "add", [5n]);
        expect(hex(payload)).to.equal(hex(selectorOf("add")) + "0000000000000005");
        expect(encoder.encodeCall(iface, "get", []).length).to.equal(4);
    });

    it("encodes addresses, hashes and 256-bit integers at their fixed widths", () => {
        const to = Address.parse("z1qxemdeddedxplasmaxxxxxxxxxxxxxxxxsctrp");
        const asset = "11".repeat(32);
        const payload = encoder.encodeCall(iface, "withdraw", [to.toString(), asset, 7n]);
        expect(hex(payload.slice(4, 24))).to.equal(hex(to.getBytes()));
        expect(hex(payload.slice(24, 56))).to.equal(asset);
        expect(hex(payload.slice(56))).to.equal("00".repeat(31) + "07");
    });

    it("encodes strings, booleans, lists and tuples", () => {
        const payload = encoder.encodeCall(iface, "label", ["hi", true, [1, 2], [9, "aabbccdd"]]);
        expect(hex(payload.slice(4))).to.equal(
            "00000002" + "6869" + "01" + "00000002" + "00000001" + "00000002" + "09" + "aabbccdd"
        );
    });

    it("rejects an unknown method and a wrong argument count or type", () => {
        expect(() => encoder.encodeCall(iface, "nope", [])).to.throw(ZenoCodecError);
        expect(() => encoder.encodeCall(iface, "add", [])).to.throw(ZenoCodecError);
        expect(() => encoder.encodeCall(iface, "add", ["x"])).to.throw(ZenoCodecError);
        expect(() => encoder.encodeCall(iface, "add", [1n << 64n])).to.throw(ZenoCodecError);
    });

    it("decodes a return value and rejects trailing bytes", () => {
        expect(encoder.decodeReturn(iface, "get", fromHex("000000000000002a"))).to.deep.equal({ total: 42n });
        expect(() => encoder.decodeReturn(iface, "get", fromHex("000000000000002a00"))).to.throw(ZenoCodecError);
        expect(encoder.decodeReturn(iface, "withdraw", new Uint8Array(0))).to.deep.equal({});
        expect(() => encoder.decodeReturn(iface, "withdraw", fromHex("00"))).to.throw(ZenoCodecError);
    });

    it("decodes a method with two outputs by name", () => {
        const data = fromHex("000000000000002a" + "00000002" + "6869");
        expect(encoder.decodeReturn(iface, "stats", data)).to.deep.equal({ count: 42n, label: "hi" });
    });

    it("encodes signed and 128-bit integers", () => {
        const payload = encoder.encodeCall(iface, "wide", [-1, -2, -3n, -4n, 2n ** 128n - 1n]);
        expect(hex(payload.slice(4))).to.equal(EXPECTED.signedVector);
        expect(() => encoder.encodeCall(iface, "wide", [128, 0, 0n, 0n, 0n])).to.throw(ZenoCodecError);
        expect(() => encoder.encodeCall(iface, "wide", [0, 0, 0n, 0n, 2n ** 128n])).to.throw(ZenoCodecError);
        expect(() => encoder.encodeCall(iface, "wide", [0, 0, 0n, 2n ** 127n, 0n])).to.throw(ZenoCodecError);
    });

    it("names an abort code and decodes the error's fields from the revert data", () => {
        const shortfall = fromHex("00".repeat(31) + "09");
        expect(encoder.decodeError(iface, 1, shortfall)).to.deep.equal({
            code: 1,
            name: "InsufficientBalance",
            fields: { shortfall: 9n },
        });
        expect(encoder.decodeError(iface, 2, new Uint8Array(0)).name).to.equal("Paused");
        expect(encoder.decodeError(iface, 99, new Uint8Array(0)).name).to.equal("unknown error 99");
        expect(encoder.decodeError(iface, -3, new Uint8Array(0)).name).to.equal("SDK failure -3");
    });

    it("refuses event topics that are not a list as a codec error", () => {
        for (const topics of [null, undefined, "x", {}, 5]) {
            expect(() => encoder.decodeEvent(iface, topics as unknown as string[], new Uint8Array(0)), String(topics)).to.throw(ZenoCodecError, "the event topics are not a list");
        }
    });

    it("decodes an event by its first topic and ignores an unknown one", () => {
        const data = fromHex("00".repeat(31) + "05");
        expect(encoder.decodeEvent(iface, [SHORTFALL_TOPIC], data)).to.deep.equal({ name: "Deposited", fields: { amount: 5n } });
        expect(() => encoder.decodeEvent(iface, [SHORTFALL_TOPIC, "22".repeat(32)], data)).to.throw(ZenoCodecError);
        expect(encoder.decodeEvent(iface, ["22".repeat(32)], data)).to.equal(null);
        expect(encoder.decodeEvent(iface, [], data)).to.equal(null);
    });

    describe("a malformed event topic or string", () => {
        const indexed = {
            ...iface,
            events: [{ name: "E", topic: SHORTFALL_TOPIC, fields: [{ name: "a", type: "u8", indexed: true }] }],
        } as ContractInterface;

        it("refuses a topic that is not hex as a ZenoCodecError", () => {
            for (const topic of ["zz", "abc", 7, null]) {
                expect(() => encoder.decodeEvent(indexed, [SHORTFALL_TOPIC, topic as string], new Uint8Array(0))).to.throw(ZenoCodecError, "an event topic is not even-length hex");
            }
        });

        it("refuses an array-like topic before allocating", () => {
            const started = Date.now();
            const topic = { length: 500_000_000 } as unknown as string;
            expect(() => encoder.decodeEvent(indexed, [SHORTFALL_TOPIC, topic], new Uint8Array(0))).to.throw(ZenoCodecError);
            expect(Date.now() - started).to.be.below(2000);
        });

        it("refuses a signature topic that is not a string as a ZenoCodecError", () => {
            expect(() => encoder.decodeEvent(indexed, [7 as unknown as string], new Uint8Array(0))).to.throw(ZenoCodecError, "not a string");
        });

        it("refuses a string that is not UTF-8 as a ZenoCodecError", () => {
            expect(() => decodeParams([{ name: "s", type: "string" }], fromHex("00000001ff"))).to.throw(ZenoCodecError, "a string is not valid UTF-8");
            expect(() => decodeParams([{ name: "s", type: "string" }], fromHex("000000ff"))).to.throw(ZenoCodecError, "truncated");
        });
    });

    describe("storage keys", () => {
        it("uses the namespace byte alone for an item", () => {
            expect(hex(encoder.storageKey(iface, "total"))).to.equal("01");
        });

        it("uses the namespace then the encoded key for a map", () => {
            expect(hex(encoder.storageKey(iface, "balances", [3n]))).to.equal("02" + "0000000000000003");
        });

        it("hashes the key when the entry is marked hashed", () => {
            const key = new Uint8Array(40).fill(7);
            const local = encoder.storageKey(iface, "blobs", [key]);
            const preimage = new Uint8Array([3, 0, 0, 0, 40, ...key]);
            expect(hex(local)).to.equal(hex(sha3_256(preimage)));
        });

        it("requires a key for a map and none for an item", () => {
            expect(() => encoder.storageKey(iface, "balances")).to.throw(ZenoCodecError);
            expect(() => encoder.storageKey(iface, "balances", [1n, 2n])).to.throw(ZenoCodecError);
            expect(() => encoder.storageKey(iface, "total", [1n])).to.throw(ZenoCodecError);
            expect(() => encoder.storageKey(iface, "missing")).to.throw(ZenoCodecError);
        });

        it("decodes a stored value", () => {
            expect(encoder.decodeStorageValue(iface, "total", fromHex("0000000000000010"))).to.equal(16n);
        });
    });
});

describe("types", () => {
    it("parses the shared vocabulary", () => {
        expect(parseType("u64")).to.deep.equal({ kind: "uint", bits: 64 });
        expect(parseType("u128")).to.deep.equal({ kind: "uint", bits: 128 });
        for (const bits of [8, 16, 32, 64, 128]) {
            expect(parseType(`i${bits}`)).to.deep.equal({ kind: "int", bits });
        }
        expect(parseType("(u8,bytes4)")).to.deep.equal({
            kind: "tuple",
            elements: [{ kind: "uint", bits: 8 }, { kind: "bytesN", length: 4 }],
        });
        expect(parseType("list<(u8,bytes4)>")).to.deep.equal({
            kind: "list",
            element: { kind: "tuple", elements: [{ kind: "uint", bits: 8 }, { kind: "bytesN", length: 4 }] },
        });
    });

    it("rejects types outside the vocabulary", () => {
        for (const type of ["i256", "bytes33", "float", "tuple<u8,i128>", "()"]) {
            expect(() => parseType(type), type).to.throw(UnsupportedTypeError);
        }
    });
});

describe("decoded records", () => {
    it("keeps a field named __proto__ as an own property", () => {
        const out = decodeParams([{ name: "__proto__", type: "u8" }, { name: "b", type: "u8" }], Uint8Array.of(7, 8));
        expect(Object.keys(out)).to.deep.equal(["__proto__", "b"]);
    });

    it("keeps event fields named __proto__ as own properties, indexed or not", () => {
        const topic = "ab".repeat(32);
        const unparsed = {
            events: [
                { name: "Indexed", topic, fields: [{ name: "__proto__", type: "u8", indexed: true }] },
                { name: "Data", topic: "cd".repeat(32), fields: [{ name: "__proto__", type: "u8", indexed: false }] },
            ],
        } as unknown as ContractInterface;
        const indexed = zenoSelectorV1.decodeEvent(unparsed, [topic, "07"], new Uint8Array(0))!.fields;
        const data = zenoSelectorV1.decodeEvent(unparsed, ["cd".repeat(32)], Uint8Array.of(8))!.fields;
        for (const [fields, value] of [[indexed, 7], [data, 8]] as const) {
            expect(Object.keys(fields)).to.deep.equal(["__proto__"]);
            expect(Object.getPrototypeOf(fields)).to.equal(Object.prototype);
            expect(Object.getOwnPropertyDescriptor(fields, "__proto__")!.value).to.equal(value);
        }
    });
});

describe("prepareDeploy and prepareCall", () => {
    it("returns the module itself with or without an interface", () => {
        expect(prepareDeploy(module, iface)).to.equal(module);
        expect(prepareDeploy(module)).to.equal(module);
    });

    it("checks the code hash, the encoding and the size", () => {
        expect(() => prepareDeploy(module, { ...iface, code_hash: "00".repeat(32) })).to.throw(/code_hash/);
        expect(() => prepareDeploy(module, iface, { interfaceEncodings: ["other"] })).to.throw(/does not accept/);
        expect(() => prepareDeploy(module, iface, { interfaceEncodings: ["zeno-selector-v1"] })).to.not.throw();
        expect(() => prepareDeploy(new Uint8Array(256 * 1024 + 1))).to.throw(/MaxCodeSize/);
        expect(() => prepareDeploy(new Uint8Array(0))).to.throw(ZenoCodecError);
    });

    it("builds a call payload and refuses one above MaxCallPayload", () => {
        expect(hex(prepareCall(iface, "add", [1n]))).to.equal(hex(selectorOf("add")) + "0000000000000001");
        const big = { ...iface, methods: [method("blob", { inputs: [{ name: "data", type: "bytes" }] })] };
        expect(() => prepareCall(big, "blob", [new Uint8Array(8 * 1024)])).to.throw(/MaxCallPayload/);
    });
});

describe("interface files and encoders", () => {
    it("parses a valid file", () => {
        expect(parseInterface(JSON.parse(JSON.stringify(iface)))).to.deep.equal(iface);
    });

    it("rejects an unseen version, a bad hash and an unknown type", () => {
        expect(() => parseInterface({ ...iface, interface_version: 2 })).to.throw(/not supported/);
        expect(() => parseInterface({ ...iface, code_hash: "zz" })).to.throw(/code_hash/);
        const unknown = { ...iface, methods: [{ ...iface.methods[0], inputs: [{ name: "x", type: "i256" }] }] };
        expect(() => parseInterface(unknown)).to.throw(ZenoCodecError, /methods\[0\]\.inputs\[0\]\.type/);
        expect(() => parseInterface(null)).to.throw(ZenoCodecError);
    });

    it("registers zeno-selector-v1 and rejects an unknown encoding", () => {
        expect(interfaceEncoderFor("zeno-selector-v1")).to.equal(zenoSelectorV1);
        expect(() => interfaceEncoderFor("slot-v1")).to.throw(UnsupportedEncodingError);
    });
});
