import { expect } from "chai";
import { Hash } from "znn-typescript-sdk";
import { InputKind, ZenoCodecError, ZenoReader, ZenoWriter, encodeInput } from "../src/index.js";

describe("settlement codec", () => {
    it("round-trips every fixed-width primitive big-endian", () => {
        const bytes = new ZenoWriter()
            .u8(0xab).u16(0x0102).u32(0x01020304).i32(-2)
            .u64(0x0102030405060708n).u256((1n << 255n) + 7n)
            .finish();

        expect(Buffer.from(bytes.slice(0, 7)).toString("hex")).to.equal("ab01020102 0304".replace(" ", ""));
        expect(Buffer.from(bytes.slice(7, 11)).toString("hex")).to.equal("fffffffe");

        const r = new ZenoReader(bytes);
        expect(r.u8()).to.equal(0xab);
        expect(r.u16()).to.equal(0x0102);
        expect(r.u32()).to.equal(0x01020304);
        expect(r.i32()).to.equal(-2);
        expect(r.u64()).to.equal(0x0102030405060708n);
        expect(r.u256()).to.equal((1n << 255n) + 7n);
        r.end();
    });

    it("writes Bytes with a u32 length prefix and lists with a u32 count", () => {
        const bytes = new ZenoWriter()
            .bytes(Uint8Array.of(9, 8))
            .list([1, 2], (w, n) => w.u8(n))
            .finish();
        expect(Buffer.from(bytes).toString("hex")).to.equal("00000002" + "0908" + "00000002" + "0102");

        const r = new ZenoReader(bytes);
        expect(Array.from(r.bytes())).to.deep.equal([9, 8]);
        expect(r.list((x) => x.u8())).to.deep.equal([1, 2]);
        r.end();
    });

    it("rejects trailing bytes", () => {
        const r = new ZenoReader(Uint8Array.of(1, 2));
        r.u8();
        expect(() => r.end()).to.throw(ZenoCodecError);
    });

    it("rejects truncated input", () => {
        expect(() => new ZenoReader(Uint8Array.of(0, 0, 1)).u32()).to.throw(ZenoCodecError);
        expect(() => new ZenoReader(Uint8Array.of(0, 0, 0, 5, 1)).bytes()).to.throw(ZenoCodecError);
        expect(() => new ZenoReader(new Uint8Array()).u8()).to.throw(ZenoCodecError);
    });

    it("rejects out-of-range values and wrong fixed widths", () => {
        expect(() => new ZenoWriter().u8(256)).to.throw(ZenoCodecError);
        expect(() => new ZenoWriter().u64(-1n)).to.throw(ZenoCodecError);
        expect(() => new ZenoWriter().u256(1n << 256n)).to.throw(ZenoCodecError);
        expect(() => new ZenoWriter().bytes32(new Uint8Array(31))).to.throw(ZenoCodecError);
    });

    it("does not range-check a u256 beyond its width", () => {
        const max = (1n << 256n) - 1n;
        expect(new ZenoReader(new ZenoWriter().u256(max).finish()).u256()).to.equal(max);
    });

    it("round-trips the signed and 128-bit widths big-endian", () => {
        const max128 = (1n << 128n) - 1n;
        const bytes = new ZenoWriter()
            .i8(-1).i16(-2).i64(-3n).i128(-4n).u128(max128)
            .i8(127).i16(-0x8000).i64(-(1n << 63n)).i128((1n << 127n) - 1n).u128(1)
            .finish();

        expect(Buffer.from(bytes.slice(0, 3)).toString("hex")).to.equal("fffffe");
        expect(Buffer.from(bytes.slice(3, 11)).toString("hex")).to.equal("fffffffffffffffd");
        expect(Buffer.from(bytes.slice(11, 27)).toString("hex")).to.equal("f".repeat(31) + "c");
        expect(Buffer.from(bytes.slice(27, 43)).toString("hex")).to.equal("f".repeat(32));

        const r = new ZenoReader(bytes);
        expect(r.i8()).to.equal(-1);
        expect(r.i16()).to.equal(-2);
        expect(r.i64()).to.equal(-3n);
        expect(r.i128()).to.equal(-4n);
        expect(r.u128()).to.equal(max128);
        expect(r.i8()).to.equal(127);
        expect(r.i16()).to.equal(-0x8000);
        expect(r.i64()).to.equal(-(1n << 63n));
        expect(r.i128()).to.equal((1n << 127n) - 1n);
        expect(r.u128()).to.equal(1n);
        r.end();
    });

    it("writes u128 and i128 as sixteen bytes", () => {
        expect(Buffer.from(new ZenoWriter().u128(0x0102n).finish()).toString("hex")).to.equal(
            "00".repeat(14) + "0102",
        );
        expect(Buffer.from(new ZenoWriter().i128(-0x0102n).finish()).toString("hex")).to.equal(
            "ff".repeat(14) + "fefe",
        );
    });

    it("rejects out-of-range signed and 128-bit values", () => {
        expect(() => new ZenoWriter().i8(128)).to.throw(ZenoCodecError);
        expect(() => new ZenoWriter().i8(-129)).to.throw(ZenoCodecError);
        expect(() => new ZenoWriter().i16(0x8000)).to.throw(ZenoCodecError);
        expect(() => new ZenoWriter().i64(1n << 63n)).to.throw(ZenoCodecError);
        expect(() => new ZenoWriter().i64(-(1n << 63n) - 1n)).to.throw(ZenoCodecError);
        expect(() => new ZenoWriter().u128(-1n)).to.throw(ZenoCodecError);
        expect(() => new ZenoWriter().u128(1n << 128n)).to.throw(ZenoCodecError);
        expect(() => new ZenoWriter().i128(1n << 127n)).to.throw(ZenoCodecError);
        expect(() => new ZenoWriter().i128(-(1n << 127n) - 1n)).to.throw(ZenoCodecError);
    });

    it("rejects truncated signed and 128-bit reads", () => {
        expect(() => new ZenoReader(new Uint8Array(15)).u128()).to.throw(ZenoCodecError);
        expect(() => new ZenoReader(new Uint8Array(15)).i128()).to.throw(ZenoCodecError);
        expect(() => new ZenoReader(new Uint8Array(7)).i64()).to.throw(ZenoCodecError);
        expect(() => new ZenoReader(new Uint8Array(1)).i16()).to.throw(ZenoCodecError);
        expect(() => new ZenoReader(new Uint8Array()).i8()).to.throw(ZenoCodecError);
    });

    it("refuses a non-integer or non-numeric argument to a 64-bit or wider writer as a codec error", () => {
        const writers: Array<[string, (w: ZenoWriter, v: never) => ZenoWriter]> = [
            ["u64", (w, v) => w.u64(v)],
            ["i64", (w, v) => w.i64(v)],
            ["u128", (w, v) => w.u128(v)],
            ["i128", (w, v) => w.i128(v)],
            ["u256", (w, v) => w.u256(v)],
        ];
        for (const [type, write] of writers) {
            for (const bad of [NaN, Infinity, 1.5, "7", null, undefined, {}]) {
                const run = () => write(new ZenoWriter(), bad as never);
                expect(run, `${type} ${String(bad)}`).to.throw(ZenoCodecError, `${type} out of range`);
            }
            expect(write(new ZenoWriter(), 5 as never).finish().length).to.be.greaterThan(0);
        }
    });

    it("refuses a non-integer caller number in an encoded input as a codec error", () => {
        const hash = Hash.parse("00".repeat(32));
        const input = { kind: InputKind.BUY_STORAGE, contractId: hash, bytes: NaN as unknown as bigint } as const;
        expect(() => encodeInput(hash, input)).to.throw(ZenoCodecError, "u64 out of range: NaN");
    });
});
