import { expect } from "chai";
import {
    ZenoWriter,
    encodeTag,
    interfaceEncoderFor,
    parseInterface,
    parseType,
    prepareDeploy,
    sha3,
} from "../src/index.js";
import { show } from "../src/format.js";
import type { ContractInterface } from "../src/index.js";

const HOSTILE = "‮" + "a".repeat(200);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function thrown(fn: () => unknown): Error {
    try {
        fn();
    } catch (error) {
        return error as Error;
    }
    throw new Error("expected a throw");
}

const bounded = (error: Error) => {
    expect(error.message).to.not.include("‮");
    expect(error.message).to.not.include("a".repeat(100));
    expect(error.message.length).to.be.below(300);
};

const iface = (extra: Record<string, unknown> = {}): ContractInterface => ({
    interface_version: 1,
    encoding: "zeno-selector-v1",
    code_hash: hex(sha3(new Uint8Array([1]))),
    methods: [],
    events: [],
    errors: [],
    storage: [],
    on_deposit: null,
    ...extra,
} as unknown as ContractInterface);

describe("error messages that quote caller or gateway input", () => {
    const encoder = interfaceEncoderFor("zeno-selector-v1");

    it("caps an interface version", () => {
        bounded(thrown(() => parseInterface({ ...iface(), interface_version: HOSTILE })));
    });

    it("caps a duplicate field name", () => {
        const doc = iface({
            methods: [{
                name: "m", selector: "00000000", payable: false, readonly: false, outputs: [],
                inputs: [{ name: HOSTILE, type: "u8" }, { name: HOSTILE, type: "u8" }],
            }],
        });
        bounded(thrown(() => parseInterface(doc)));
    });

    it("caps a type with no encoding", () => {
        bounded(thrown(() => parseType(HOSTILE)));
    });

    it("caps a method, a storage entry and a key count in a lookup", () => {
        bounded(thrown(() => encoder.encodeCall(iface(), HOSTILE, [])));
        bounded(thrown(() => encoder.storageKey(iface(), HOSTILE)));
    });

    it("caps a parameter name in a value error", () => {
        const doc = iface({
            methods: [{
                name: "m", selector: hex(sha3(new TextEncoder().encode("m")).slice(0, 4)), payable: false, readonly: false,
                outputs: [], inputs: [{ name: HOSTILE, type: "bool" }],
            }],
        });
        bounded(thrown(() => encoder.encodeCall(doc, "m", ["not a boolean" as never])));
    });

    it("caps a batch id given as a huge number", () => {
        const error = thrown(() => encodeTag(10n ** 500n));
        expect(error.message.length).to.be.below(300);
    });

    it("quotes a bigint interface version as a codec error", () => {
        const error = thrown(() => parseInterface({ ...iface(), interface_version: 2n }));
        expect(error.name).to.equal("ZenoCodecError");
        expect(error.message).to.equal("interface_version 2 is not supported");
    });

    it("caps the encoding of an interface a domain does not accept", () => {
        const error = thrown(() => prepareDeploy(new Uint8Array([1]), iface({ encoding: HOSTILE }), { interfaceEncodings: ["zeno-selector-v1"] }));
        expect(error.message).to.include("does not accept");
        bounded(error);
    });

    it("caps the encoding that has no registered encoder", () => {
        const error = thrown(() => interfaceEncoderFor(HOSTILE));
        expect(error.name).to.equal("UnsupportedEncodingError");
        bounded(error);
    });

    it("caps an L1 address argument that does not parse", () => {
        const doc = iface({
            methods: [{
                name: "m", selector: hex(sha3(new TextEncoder().encode("m")).slice(0, 4)), payable: false, readonly: false,
                outputs: [], inputs: [{ name: "who", type: "l1Address" }],
            }],
        });
        const error = thrown(() => encoder.encodeCall(doc, "m", [HOSTILE]));
        expect(error.message).to.equal('"who" is not an L1 address');
    });

    it("caps a storage name and a key count in a storage lookup", () => {
        const doc = iface({
            storage: [{ name: "balances", namespace: "0x01", hashed: false, key: [{ name: "k", type: "u8" }], value: { type: "u8" } }],
        });
        const error = thrown(() => encoder.storageKey(doc, "balances", [1, 2]));
        expect(error.message).to.equal('"balances" takes 1 key values, got 2');
    });

    it("quotes a bigint, a cyclic object and a symbol without throwing", () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(show(2n)).to.equal("2");
        expect(show(cyclic)).to.equal('{"self":[Circular]}');
        expect(show(Symbol("s"))).to.equal("Symbol(s)");
        expect(show(undefined)).to.equal("undefined");
    });

    it("quotes every kind of JavaScript value", () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        const fn = function f() { return 1; };
        class Point {
            x = NaN;
        }
        const table: Array<[string, unknown, string]> = [
            ["undefined", undefined, "undefined"],
            ["NaN", NaN, "NaN"],
            ["Infinity", Infinity, "Infinity"],
            ["-Infinity", -Infinity, "-Infinity"],
            ["-0", -0, "-0"],
            ["a number", 42, "42"],
            ["null", null, "null"],
            ["true", true, "true"],
            ["a string", "a\u0007b", '"a\\u0007b"'],
            ["a bidi string", "\u202eab", '"\\u202eab"'],
            ["a symbol", Symbol("s"), "Symbol(s)"],
            ["a function", fn, String(fn)],
            ["a bigint", 2n, "2"],
            ["a plain object", { b: "c" }, '{"b":"c"}'],
            ["a null prototype object", Object.assign(Object.create(null), { b: 1 }), '{"b":1}'],
            ["a class instance", new Point(), 'Point{"x":NaN}'],
            ["a cyclic object", cyclic, '{"self":[Circular]}'],
            ["a Map", new Map<unknown, unknown>([[1, 2n]]), "Map{1=>2}"],
            ["a Set", new Set([1, NaN]), "Set{1,NaN}"],
            ["an Error", new Error("boom"), "Error: boom"],
            ["a Date", new Date(0), "1970-01-01T00:00:00.000Z"],
            ["an invalid Date", new Date(NaN), "Invalid Date"],
            ["a boxed NaN", new Number(NaN), "Number(NaN)"],
            ["a Uint8Array", Uint8Array.of(1, 2), "Uint8Array[1,2]"],
            ["a Float64Array", Float64Array.of(NaN), "Float64Array[NaN]"],
            ["a Buffer", Buffer.from([3]), "Buffer[3]"],
            ["a DataView", new DataView(Uint8Array.of(4).buffer), "DataView[4]"],
            ["an array", [1, [Infinity, { a: 1n }]], "[1,[Infinity,{\"a\":1}]]"],
        ];
        for (const [label, value, want] of table) {
            expect(show(value), label).to.equal(want);
            expect(show([value]), `${label} in an array`).to.equal(`[${want}]`);
            expect(show({ k: value }), `${label} in an object`).to.equal(`{"k":${want}}`);
        }
    });

    it("caps the output of a huge value and a deep one", () => {
        let deep: unknown = 1;
        for (let i = 0; i < 100; i++) deep = [deep];
        expect(show(new Array(1e6).fill(7)).length).to.be.at.most(80);
        expect(show(deep).length).to.be.at.most(80);
        expect(show(new Uint8Array(1e7)).length).to.be.at.most(80);
        expect(show({ s: HOSTILE })).to.not.include("‮");
    });

    it("names NaN and Infinity in a range error", () => {
        expect(thrown(() => new ZenoWriter().u8(NaN)).message).to.equal("u8 out of range: NaN");
        expect(thrown(() => new ZenoWriter().u32(Infinity)).message).to.equal("u32 out of range: Infinity");
    });

    it("names the type and the value in a codec range error", () => {
        expect(thrown(() => new ZenoWriter().u8(300)).message).to.match(/u8 out of range: 300/);
    });
});
