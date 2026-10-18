import { expect } from "chai";
import { sha3_256 } from "@noble/hashes/sha3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Address } from "znn-typescript-sdk";
import { ZenoCodecError, parseInterface, prepareCall, zenoSelectorV1 } from "../src/index.js";
import type { ContractInterface } from "../src/index.js";

// Expected values, computed independently of the SDK: file digests with SHA-256, encodings with @noble/hashes sha3_256 and BigInt.asUintN.
const FIXTURE_SHA256: Record<string, string> = {
    "counter.interface.json": "5f2dcc4e1d72cc4636fa294e9083c8b0d02d20bc63bd5d1d936e70583ea8238b",
    "counter-v2.interface.json": "3da8a888fd3ee244f109669f0ea90ac43275b4f891e9769ed3c18626e1e51aec",
    "vault.interface.json": "26f4d8c1b1d1cbf9dcf2ed4d99fcbc4b8e81af5bfb476c756bfd99b759fefba9",
};
const WITHDRAW_PAYLOAD_PREFIX =
    "24b2e5fc" + "11".repeat(32) + "00000000000000000000000000000000000000000000000000000000000003e8";
const INCREMENT_RETURN_42 = "000000000000002a";
const INSUFFICIENT_BALANCE_REVERT =
    "11".repeat(32) +
    "0000000000000000000000000000000000000000000000000000000000000005" +
    "0000000000000000000000000000000000000000000000000000000000000003";
const DEPOSITED_1000_DATA = "00000000000000000000000000000000000000000000000000000000000003e8";
const VAULT_BALANCES_KEY = "b3f6ca9ab8b03e55a1bbffcb9129fee086fa715d2230d00bd14af2eccf067eff";

const read = (file: string) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8");
const load = (file: string): ContractInterface => parseInterface(JSON.parse(read(file)));
const fromHex = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const utf8 = (text: string) => new TextEncoder().encode(text);
type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const clone = (): Doc => structuredClone(JSON.parse(read("vault.interface.json")));

const encoder = zenoSelectorV1;
const RECIPIENT = "z1qxemdeddedxplasmaxxxxxxxxxxxxxxxxsctrp";

describe("committed interface files", () => {
    it("accepts the counter, counter-v2 and reference vault files and returns the object it was given", () => {
        for (const file of Object.keys(FIXTURE_SHA256)) {
            const json = JSON.parse(read(file));
            expect(parseInterface(json), file).to.equal(json);
        }
    });

    it("pins each fixture by its SHA-256", () => {
        for (const [file, digest] of Object.entries(FIXTURE_SHA256)) {
            expect(createHash("sha256").update(read(file)).digest("hex"), file).to.equal(digest);
        }
    });

    describe("rejections", () => {
        const cases: [string, (doc: Doc) => void, RegExp][] = [
            ["an i256 storage value", (d) => { d.storage[0].value = "i256"; }, /storage\[0\]\.value/],
            ["a wrong selector", (d) => { d.methods[0].selector = "00000000"; }, /methods\[0\]\.selector/],
            ["a wrong topic", (d) => { d.events[0].topic = "00".repeat(32); }, /events\[0\]\.topic/],
            [
                "four indexed fields",
                (d) => {
                    d.events[0].fields = ["a", "b", "c", "d"].map((name) => ({ name, type: "hash", indexed: true }));
                },
                /events\[0\]\.fields/,
            ],
            ["namespace 0x00", (d) => { d.storage[0].namespace = "0x00"; }, /storage\[0\]\.namespace/],
            ["a missing on_deposit", (d) => { delete d.on_deposit; }, /on_deposit/],
            ["a field without a type", (d) => { delete d.events[0].fields[2].type; }, /events\[0\]\.fields\[2\]\.type/],
            ["a key field without a name", (d) => { delete d.storage[0].key[0].name; }, /storage\[0\]\.key\[0\]\.name/],
            ["a null method", (d) => { d.methods[0] = null; }, /methods\[0\]: must be an object/],
            ["a duplicate event field name", (d) => { d.events[0].fields[1].name = "account"; }, /events\[0\]\.fields\[1\]\.name: duplicate name "account"/],
            ["a __proto__ method input", (d) => { d.methods[0].inputs[0].name = "__proto__"; }, /methods\[0\]\.inputs\[0\]\.name: reserved name/],
            ["a duplicate error field name", (d) => { d.errors[0].fields[1].name = "asset"; }, /errors\[0\]\.fields\[1\]\.name: duplicate name "asset"/],
            ["a hashed flag that contradicts the key", (d) => { d.storage[0].hashed = false; }, /storage\[0\]\.hashed/],
        ];
        for (const [title, mutate, pattern] of cases) {
            it(`names the path for ${title}`, () => {
                const doc = clone();
                mutate(doc);
                expect(() => parseInterface(doc)).to.throw(ZenoCodecError, pattern);
            });
        }
    });

    it("accepts a type nested 32 lists deep and rejects 33 with the field path", () => {
        const nested = (n: number) => "list<".repeat(n) + "u8" + ">".repeat(n);
        const ok = clone();
        ok.storage[0].value = nested(32);
        expect(() => parseInterface(ok)).to.not.throw();
        const deep = clone();
        deep.storage[0].value = nested(33);
        expect(() => parseInterface(deep)).to.throw(ZenoCodecError, /storage\[0\]\.value/);
        const tuples = clone();
        tuples.storage[0].value = "(".repeat(40) + "u8" + ")".repeat(40);
        expect(() => parseInterface(tuples)).to.throw(ZenoCodecError, /storage\[0\]\.value/);
    });

    it("carries selectors and topics that equal SHA3-256 prefixes of the names", () => {
        for (const file of Object.keys(FIXTURE_SHA256)) {
            const doc = load(file);
            for (const m of doc.methods) expect(m.selector, `${file} ${m.name}`).to.equal(hex(sha3_256(utf8(m.name)).slice(0, 4)));
            for (const e of doc.events) expect(e.topic, `${file} ${e.name}`).to.equal(hex(sha3_256(utf8(e.name))));
        }
    });

    it("encodes the reference vault withdraw payload", () => {
        const vault = load("vault.interface.json");
        const payload = prepareCall(vault, "withdraw", ["11".repeat(32), 1000n, RECIPIENT]);
        expect(hex(payload)).to.equal(WITHDRAW_PAYLOAD_PREFIX + hex(Address.parse(RECIPIENT).getBytes()));
    });

    it("decodes the counter-v2 increment return and rejects extra bytes", () => {
        const counter = load("counter-v2.interface.json");
        expect(encoder.decodeReturn(counter, "increment", fromHex(INCREMENT_RETURN_42))).to.deep.equal({ count: 42n });
        expect(() => encoder.decodeReturn(counter, "increment", fromHex(INCREMENT_RETURN_42 + "00"))).to.throw(ZenoCodecError);
    });

    it("decodes the reference vault events", () => {
        const vault = load("vault.interface.json");
        const deposited = vault.events[0].topic;
        const decoded = encoder.decodeEvent(vault, [deposited, "aa".repeat(32), "bb".repeat(32)], fromHex(DEPOSITED_1000_DATA));
        expect(decoded).to.deep.equal({
            name: "Deposited",
            fields: { account: "aa".repeat(32), asset: new Uint8Array(32).fill(0xbb), amount: 1000n },
        });
        const withdrawn = vault.events[1].topic;
        const data = fromHex(DEPOSITED_1000_DATA + hex(Address.parse(RECIPIENT).getBytes()));
        const out = encoder.decodeEvent(vault, [withdrawn, "aa".repeat(32), "bb".repeat(32)], data);
        expect(out?.fields.l1_recipient).to.equal(RECIPIENT);
        expect(() => encoder.decodeEvent(vault, [deposited, "aa".repeat(32)], fromHex(DEPOSITED_1000_DATA))).to.throw(ZenoCodecError);
    });

    it("names the reference vault and counter errors", () => {
        const vault = load("vault.interface.json");
        expect(encoder.decodeError(vault, 1, fromHex(INSUFFICIENT_BALANCE_REVERT))).to.deep.equal({
            code: 1,
            name: "InsufficientBalance",
            fields: { asset: new Uint8Array(32).fill(0x11), requested: 5n, available: 3n },
        });
        expect(encoder.decodeError(vault, -9, new Uint8Array(0)).name).to.equal("InvalidRecipient");
        expect(encoder.decodeError(vault, -3, new Uint8Array(0)).name).to.equal("SDK failure -3");
        expect(encoder.decodeError(load("counter.interface.json"), -3, new Uint8Array(0)).name).to.equal("NoDepositHandler");
    });

    it("derives storage keys for the counter and the reference vault", () => {
        expect(hex(encoder.storageKey(load("counter.interface.json"), "count"))).to.equal("01");
        const vault = load("vault.interface.json");
        expect(hex(encoder.storageKey(vault, "balances", ["aa".repeat(32), "bb".repeat(32)]))).to.equal(VAULT_BALANCES_KEY);
        expect(encoder.decodeStorageValue(vault, "balances", fromHex(DEPOSITED_1000_DATA))).to.equal(1000n);
    });
});

describe("interface file validation edges", () => {
    for (const [title, input] of [["a string", "x"], ["a number", 1], ["a list", []], ["undefined", undefined]] as const) {
        it(`rejects ${title} as not an object`, () => {
            expect(() => parseInterface(input)).to.throw(ZenoCodecError, /not an object/);
        });
    }

    it("rejects a null field entry and a field list that is not a list, never with a bare TypeError", () => {
        const nullField = clone();
        nullField.methods[0].inputs[0] = null;
        expect(() => parseInterface(nullField)).to.throw(ZenoCodecError, /methods\[0\]\.inputs\[0\]: must be an object/);
        const notList = clone();
        notList.methods[0].outputs = "u64";
        expect(() => parseInterface(notList)).to.throw(ZenoCodecError, /methods\[0\]\.outputs: must be a list/);
        const keyNotList = clone();
        keyNotList.storage[0].key = {};
        expect(() => parseInterface(keyNotList)).to.throw(ZenoCodecError, /storage\[0\]\.key: must be a list/);
    });

    describe("the hashed flag follows the 30-byte key rule", () => {
        const withKey = (types: string[], hashed: boolean): Doc => {
            const doc = clone();
            doc.storage[0].key = types.map((type, i) => ({ name: `k${i}`, type }));
            doc.storage[0].hashed = hashed;
            return doc;
        };
        const cases: [string, string[], boolean][] = [
            ["fixed fields summing to 30 bytes", ["u128", "u64", "u32", "u16"], false],
            ["fixed fields summing to 31 bytes", ["u128", "u64", "u32", "u16", "u8"], true],
            ["a tuple summing to 30 bytes", ["(u128,u64,u32,u16)"], false],
            ["a tuple summing to 32 bytes", ["(u128,u128)"], true],
            ["a bytes key", ["bytes"], true],
            ["a list key", ["list<u8>"], true],
            ["a tuple holding a string", ["(u8,string)"], true],
        ];
        for (const [title, types, mustHash] of cases) {
            it(`accepts hashed ${mustHash} and rejects hashed ${!mustHash} for ${title}`, () => {
                expect(() => parseInterface(withKey(types, mustHash))).to.not.throw();
                expect(() => parseInterface(withKey(types, !mustHash))).to.throw(
                    ZenoCodecError,
                    new RegExp(`storage\\[0\\]\\.hashed: must be ${mustHash} for this key`),
                );
            });
        }
    });
});
