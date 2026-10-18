import { expect } from "chai";
import { Hash } from "znn-typescript-sdk";
import type { Client } from "znn-typescript-sdk";
import { GatewayClient, GatewayVerificationError } from "../../src/index.js";
import type { BatchSource } from "../../src/index.js";
import { call, startReplay } from "./replay.js";
import type { RecordedCall } from "./replay.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const result = (name: string): Json => (call(name).response as { result: Json }).result;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const fake = (reply: (method: string) => unknown, options: ConstructorParameters<typeof GatewayClient>[1] = {}) =>
    new GatewayClient({ sendRequest: async (method: string) => reply(method) } as unknown as Client, options);

async function rejection(promise: Promise<unknown>): Promise<GatewayVerificationError> {
    try {
        await promise;
    } catch (error) {
        expect(error, (error as Error).message).to.be.instanceOf(GatewayVerificationError);
        return error as GatewayVerificationError;
    }
    throw new Error("expected a GatewayVerificationError");
}

const batch = result("getBatch latest");
const source: BatchSource = async () => ({
    preStateRoot: Hash.parse(batch.preStateRoot),
    postStateRoot: Hash.parse(batch.postStateRoot),
    inputRoot: Hash.parse(batch.inputRoot),
    receiptRoot: Hash.parse(batch.receiptRoot),
    eventRoot: Hash.parse(batch.eventRoot),
    outboxRoot: Hash.parse(batch.outboxRoot),
    daHash: Hash.parse(batch.daHash),
    isFinalized: false,
});

describe("a malformed gateway result", () => {
    it("fails getProof with a verification error", async () => {
        const path = "00".repeat(32);
        for (const bad of [{}, null, { proofs: [null] }, { proofs: "x" }]) {
            const error = await rejection(fake(() => bad).getProof(1, [path]));
            expect(error.check).to.equal("result structure");
        }
    });

    it("fails read with a verification error", async () => {
        for (const bad of [null, { postStateRoot: "00".repeat(32) }, { postStateRoot: "00".repeat(32), proofs: [null] }]) {
            await rejection(fake(() => bad).read(1, "contract", {}));
        }
    });

    it("fails getStateAt and getBatch on a null result", async () => {
        await rejection(fake(() => null).getStateAt(1, "00".repeat(32)));
        await rejection(fake(() => null, { batches: source }).getBatch(1));
    });

    it("fails getBatch when a verified batch has a missing or non-string root", async () => {
        for (const root of [undefined, 5, null]) {
            const bad = { ...batch, verified: true, postStateRoot: root };
            const error = await rejection(fake(() => bad, { batches: source }).getBatch(1));
            expect(error.check).to.equal("batch commitment");
        }
    });

    it("fails contracts() on a missing profile list, a bad profile or missing features", async () => {
        const info = result("chainInfo");
        await rejection(fake(() => null).contracts(1));
        await rejection(fake(() => ({ ...info, profiles: undefined })).contracts(1));
        await rejection(fake(() => ({ ...info, profiles: [null] })).contracts(1));
        await rejection(fake(() => ({ ...info, profiles: [{ name: "contracts/1" }] })).contracts(1));
    });

    it("fails module() on a null result", async () => {
        const reply = (method: string) =>
            method === "zeno_chainInfo"
                ? result("chainInfo")
                : { domainId: 1, batchId: 1, verified: false, postStateRoot: "00".repeat(32), proofs: [], result: null };
        const contracts = await fake(reply).contracts(1);
        await rejection(contracts.module("00".repeat(32)));
    });

    describe("with proofs that verify", () => {
        const replaced = (name: string, edit: (r: Json) => void): RecordedCall => {
            const recorded = call(name);
            const response = clone(recorded.response) as { result: Json };
            edit(response.result);
            return { ...recorded, response: response as RecordedCall["response"] };
        };

        async function readWith(extra: RecordedCall[], name: string, params?: Record<string, unknown>) {
            const replay = await startReplay(extra);
            const client = await GatewayClient.connect(replay.url);
            try {
                const [domain, view, recordedParams] = call(name).params as [number, string, Record<string, unknown>];
                return await client.read(domain, view, params ?? recordedParams);
            } finally {
                client.close();
                await replay.close();
            }
        }

        it("fails a contract view whose result is null", async () => {
            const error = await rejection(readWith([replaced("read contract", (r) => { r.result = null; })], "read contract"));
            expect(error.check).to.equal("result structure");
        });

        it("fails a storage view whose result is null", async () => {
            const error = await rejection(readWith([replaced("read storage", (r) => { r.result = null; })], "read storage"));
            expect(error.check).to.equal("result structure");
        });

        it("fails a storage view whose key is not even-length hex", async () => {
            const recorded = call("read storage");
            const [domain, view, params] = recorded.params as [number, string, Record<string, unknown>];
            const withoutKey = { ...params };
            delete withoutKey.key;
            for (const bad of [{ ...params, key: "abc" }, { ...params, key: "zz" }, withoutKey]) {
                const extra: RecordedCall = { ...recorded, params: [domain, view, bad] };
                const error = await rejection(readWith([extra], "read storage", bad));
                expect(error.check).to.equal("path derivation");
                expect(error.message).to.include("the storage key is not even-length hex");
            }
        });
    });
});
