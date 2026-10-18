import { expect } from "chai";
import { Hash, ZNN_ZTS, settlement } from "znn-typescript-sdk";
import {
    OutboxKind,
    ZenoCodecError,
    ZenoWriter,
    decodeBundle,
    decodeDeployReturnData,
    decodeExecutionResult,
    decodeOutboxMessage,
    decodeReceipt,
    decodeRevertData,
    decodeUpgradeReturnData,
    ReceiptStatus,
} from "../src/index.js";

const { assetIdFromZts } = settlement;

const b32 = (n: number) => new Uint8Array(32).fill(n);
const addr = (n: number) => new Uint8Array(20).fill(n);

describe("settlement decoders", () => {
    it("decodes a Receipt with a signed abort code", () => {
        const data = new ZenoWriter()
            .u16(1).u64(5n).bytes32(b32(1)).u64(2n).bytes32(b32(3)).bytes32(b32(4))
            .u8(ReceiptStatus.REVERT).u64(900n).i32(-7)
            .bytes32(b32(0)).bytes32(b32(5)).bytes32(b32(0)).u32(0).bytes32(b32(0)).u32(0)
            .finish();

        const receipt = decodeReceipt(data);
        expect(receipt.inputIndex).to.equal(5n);
        expect(receipt.status).to.equal(ReceiptStatus.REVERT);
        expect(receipt.gasUsed).to.equal(900n);
        expect(receipt.abortCode).to.equal(-7);
        expect(receipt.returnHash.toString()).to.equal("05".repeat(32));
    });

    it("rejects a Receipt with trailing bytes", () => {
        const data = new ZenoWriter()
            .u16(1).u64(0n).bytes32(b32(0)).u64(0n).bytes32(b32(0)).bytes32(b32(0))
            .u8(0).u64(0n).i32(0)
            .bytes32(b32(0)).bytes32(b32(0)).bytes32(b32(0)).u32(0).bytes32(b32(0)).u32(0)
            .u8(0)
            .finish();
        expect(() => decodeReceipt(data)).to.throw(ZenoCodecError);
    });

    describe("OutboxMessage", () => {
        it("decodes an L2 delivery", () => {
            const data = new ZenoWriter()
                .bytes32(b32(1)).u64(2n).u32(0).u8(0).bytes32(b32(9)).bytes(Uint8Array.of(1, 2))
                .finish();
            const message = decodeOutboxMessage(data);
            expect(message.kind).to.equal(OutboxKind.L2_DELIVERY);
            expect(Array.from(message.payload)).to.deep.equal([1, 2]);
        });

        it("decodes an L1 withdrawal", () => {
            const data = new ZenoWriter()
                .bytes32(b32(1)).u64(2n).u32(0).u8(1)
                .address(addr(7)).bytes32(assetIdFromZts(ZNN_ZTS).getBytes()).u256(55n).bytes(new Uint8Array())
                .finish();
            const message = decodeOutboxMessage(data);
            expect(message.kind).to.equal(OutboxKind.L1_WITHDRAWAL);
            if (message.kind === OutboxKind.L1_WITHDRAWAL) {
                expect(message.amount).to.equal(55n);
            }
        });

        it("rejects an unknown kind", () => {
            const data = new ZenoWriter().bytes32(b32(1)).u64(2n).u32(0).u8(2).finish();
            expect(() => decodeOutboxMessage(data)).to.throw(ZenoCodecError);
        });

        it("rejects a withdrawal with a non-canonical asset id", () => {
            const data = new ZenoWriter()
                .bytes32(b32(1)).u64(2n).u32(0).u8(1)
                .address(addr(7)).bytes32(b32(1)).u256(1n).bytes(new Uint8Array())
                .finish();
            expect(() => decodeOutboxMessage(data)).to.throw(ZenoCodecError);
        });
    });

    describe("ExecutionResult", () => {
        const build = (keys: number[], tweak?: (w: ZenoWriter) => void) => {
            const w = new ZenoWriter().u16(1).u64(3n).bytes32(b32(1)).bytes32(b32(2));
            w.list(keys, (x, k) => {
                x.bytes32(b32(k));
                if (k === 9) x.u32(0xffffffff);
                else x.bytes(Uint8Array.of(k));
            });
            w.list([], () => undefined).list([], () => undefined).bytes(Uint8Array.of(7)).u256(0n);
            tweak?.(w);
            return w.finish();
        };

        it("decodes state diff entries including the EMPTY sentinel", () => {
            const result = decodeExecutionResult(build([1, 5, 9]));
            expect(result.stateDiff).to.have.length(3);
            expect(result.stateDiff[2].value).to.equal(null);
            expect(Array.from(result.stateDiff[0].value!)).to.deep.equal([1]);
            expect(Array.from(result.returnData)).to.deep.equal([7]);
        });

        it("rejects an unsorted or duplicated StateDiff", () => {
            expect(() => decodeExecutionResult(build([5, 1]))).to.throw(ZenoCodecError);
            expect(() => decodeExecutionResult(build([5, 5]))).to.throw(ZenoCodecError);
        });

        it("rejects trailing bytes", () => {
            expect(() => decodeExecutionResult(build([1], (w) => w.u8(0)))).to.throw(ZenoCodecError);
        });

        it("rejects ReturnData above MaxReturnData", () => {
            const data = new ZenoWriter().u16(1).u64(0n).bytes32(b32(0)).bytes32(b32(0))
                .list([], () => undefined).list([], () => undefined).list([], () => undefined)
                .bytes(new Uint8Array(4097)).u256(0n).finish();
            expect(() => decodeExecutionResult(data)).to.throw(ZenoCodecError);
        });

        const withVersion = (version: number, events: (w: ZenoWriter) => void, outbox: (w: ZenoWriter) => void) => {
            const w = new ZenoWriter().u16(version).u64(3n).bytes32(b32(1)).bytes32(b32(2)).u32(0);
            events(w);
            outbox(w);
            return w.bytes(new Uint8Array()).u256(0n).finish();
        };
        const none = (w: ZenoWriter) => w.u32(0);
        const event = (w: ZenoWriter, eventIndex: number, inputIndex: bigint) =>
            w.bytes32(b32(5)).u64(inputIndex).u32(eventIndex).u32(0).bytes(new Uint8Array());
        const message = (w: ZenoWriter, outboxIndex: number, inputIndex: bigint) =>
            w.bytes32(b32(5)).u64(inputIndex).u32(outboxIndex).u8(0).bytes32(b32(9)).bytes(new Uint8Array());

        it("rejects an unknown version", () => {
            expect(() => decodeExecutionResult(withVersion(2, none, none))).to.throw(ZenoCodecError, /version 2/);
        });

        it("rejects an event whose eventIndex is not its position", () => {
            const events = (w: ZenoWriter) => { w.u32(2); event(w, 0, 3n); event(w, 2, 3n); };
            expect(() => decodeExecutionResult(withVersion(1, events, none))).to.throw(ZenoCodecError, /eventIndex/);
        });

        it("rejects an event with another inputIndex than the globalInputIndex", () => {
            const events = (w: ZenoWriter) => { w.u32(1); event(w, 0, 4n); };
            expect(() => decodeExecutionResult(withVersion(1, events, none))).to.throw(ZenoCodecError, /inputIndex/);
        });

        it("rejects an outbox message whose outboxIndex is not its position", () => {
            const outbox = (w: ZenoWriter) => { w.u32(1); message(w, 1, 3n); };
            expect(() => decodeExecutionResult(withVersion(1, none, outbox))).to.throw(ZenoCodecError, /outboxIndex/);
        });

        it("rejects an outbox message with another inputIndex than the globalInputIndex", () => {
            const outbox = (w: ZenoWriter) => { w.u32(1); message(w, 0, 4n); };
            expect(() => decodeExecutionResult(withVersion(1, none, outbox))).to.throw(ZenoCodecError, /inputIndex/);
        });

        it("decodes numbered events and outbox messages that carry the globalInputIndex", () => {
            const events = (w: ZenoWriter) => { w.u32(2); event(w, 0, 3n); event(w, 1, 3n); };
            const outbox = (w: ZenoWriter) => { w.u32(1); message(w, 0, 3n); };
            const result = decodeExecutionResult(withVersion(1, events, outbox));
            expect(result.events).to.have.length(2);
            expect(result.outbox).to.have.length(1);
        });
    });

    describe("DA bundle", () => {
        const record = (w: ZenoWriter, index: bigint, witnessKeys: number[] = []) => {
            w.u64(index).bytes(Uint8Array.of(0, 1, 2));
            w.list(witnessKeys, (x, k) => x.bytes32(b32(k)).bytes(Uint8Array.of(k)).bytes(Uint8Array.of(9)));
            w.bytes(Uint8Array.of(7));
        };

        it("decodes ascending records and witnesses", () => {
            const w = new ZenoWriter();
            record(w, 1n, [1, 2]);
            record(w, 2n);
            const records = decodeBundle(w.finish());
            expect(records.map((r) => r.globalInputIndex)).to.deep.equal([1n, 2n]);
            expect(records[0].witnesses).to.have.length(2);
        });

        it("rejects records that do not ascend by globalInputIndex", () => {
            const descending = new ZenoWriter();
            record(descending, 2n);
            record(descending, 1n);
            expect(() => decodeBundle(descending.finish())).to.throw(ZenoCodecError, /globalInputIndex/);
            const repeated = new ZenoWriter();
            record(repeated, 1n);
            record(repeated, 1n);
            expect(() => decodeBundle(repeated.finish())).to.throw(ZenoCodecError, /globalInputIndex/);
        });

        it("rejects witnesses whose keys descend", () => {
            const w = new ZenoWriter();
            record(w, 1n, [2, 1]);
            expect(() => decodeBundle(w.finish())).to.throw(ZenoCodecError, /witness keys/);
        });

        it("rejects witnesses whose keys repeat", () => {
            const w = new ZenoWriter();
            record(w, 1n, [3, 3]);
            expect(() => decodeBundle(w.finish())).to.throw(ZenoCodecError, /witness keys/);
        });
    });

    it("decodes deploy and upgrade ReturnData", () => {
        const deploy = decodeDeployReturnData(new ZenoWriter().bytes32(b32(1)).bytes32(b32(2)).finish());
        expect(deploy.codeHash.toString()).to.equal("01".repeat(32));
        expect(deploy.executableCodeHash.toString()).to.equal("02".repeat(32));

        const upgrade = decodeUpgradeReturnData(new ZenoWriter().bytes32(b32(3)).bytes32(b32(4)).finish());
        expect(upgrade.oldCodeHash.toString()).to.equal("03".repeat(32));
        expect(upgrade.newCodeHash).to.be.instanceOf(Hash);

        expect(() => decodeDeployReturnData(new Uint8Array(63))).to.throw(ZenoCodecError);
        expect(() => decodeUpgradeReturnData(new Uint8Array(65))).to.throw(ZenoCodecError);
    });

    it("returns revert data with its abort code", () => {
        const revert = decodeRevertData(12, Uint8Array.of(1, 2, 3));
        expect(revert.abortCode).to.equal(12);
        expect(Array.from(revert.data)).to.deep.equal([1, 2, 3]);
        expect(() => decodeRevertData(1, new Uint8Array(4097))).to.throw(ZenoCodecError);
    });
});
