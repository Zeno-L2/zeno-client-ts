import { expect } from "chai";
import { readFileSync } from "node:fs";
import {
    Address,
    BlockTypeEnum,
    Hash,
    PLASMA_ADDRESS,
    SETTLEMENT_ADDRESS,
    SettlementContract,
    ZNN_ZTS,
    settlement as sdkSettlement,
} from "znn-typescript-sdk";
import type { TokenStandard } from "znn-typescript-sdk";
import {
    GatewayClient,
    GatewayVerificationError,
    NotFoundError,
    OutboxKind,
    InputKind,
    ReceiptStatus,
    UnsupportedProfileError,
    mapGatewayError,
    ZenoWriter,
    decodeExecutionResult,
    encodeInput,
    merkleRoot,
    sha3,
    smtKey,
    wasmPathDerivation,
} from "../../src/index.js";
import type { BatchSource, ReadResult, SendBlock, SendSource, SettlementBatchEntry } from "../../src/index.js";
import { call, startReplay, syntheticError } from "./replay.js";
import type { RecordedCall, Replay } from "./replay.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const result = (name: string): Json => (call(name).response as { result: Json }).result;

/**
 * Stands in for Settlement: batch entries built from the commitments the
 * recorded gateway returned for batches 0 and 3. The checks under test
 * compare a result against these entries, so a tampered entry plays the
 * part of a gateway that disagrees with L1.
 */
const entryOf = (batch: Json, finalized = false): SettlementBatchEntry => ({
    preStateRoot: Hash.parse(batch.preStateRoot),
    postStateRoot: Hash.parse(batch.postStateRoot),
    inputRoot: Hash.parse(batch.inputRoot),
    receiptRoot: Hash.parse(batch.receiptRoot),
    eventRoot: Hash.parse(batch.eventRoot),
    outboxRoot: Hash.parse(batch.outboxRoot),
    daHash: Hash.parse(batch.daHash),
    isFinalized: finalized,
});

const batches: Record<number, Json> = { 0: result("getBatch by id"), 3: result("getBatch latest") };
const settlement: BatchSource = async (_domain, id) => (batches[id] ? entryOf(batches[id]) : null);

const contractParams = call("read contract").params as [number, string, Record<string, unknown>];
const [DOMAIN, VIEW, PARAMS] = contractParams;

const SEND = "04ee000000000000000000000000000000000000000000000000000000000000";
const SENDER = "z16yqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqvrvjf7";

/** A `UserSend` to Settlement from `SENDER` that calls `method` with `args`. */
const sendOf = (method: string, args: unknown[], tokenStandard: TokenStandard = ZNN_ZTS, amount: bigint = 0n): SendBlock => ({
    blockType: BlockTypeEnum.UserSend,
    address: Address.parse(SENDER),
    toAddress: SETTLEMENT_ADDRESS,
    tokenStandard,
    amount,
    data: Uint8Array.from(Buffer.from(SettlementContract.encodeCall(method, args).replace(/^0x/, ""), "hex")),
});

/** Stands in for the node: the blocks by send hash. */
const nodeOf = (blocks: Record<string, SendBlock>): SendSource => async (hash) => blocks[hash.toString()] ?? null;

/** Wraps a source and records the hashes it was asked for. */
const counting = <A extends unknown[], T>(inner: (...args: A) => Promise<T>) => {
    const seen: string[] = [];
    const source = async (...args: A): Promise<T> => {
        seen.push(String(args[0]));
        return inner(...args);
    };
    return { source, seen };
};

const RECORDED_CODE_HASH = result("getReceipt success").input.codeHash as string;
const RECORDED_SEND = sendOf("DeployContractFinalize", [1, "0x" + RECORDED_CODE_HASH], ZNN_ZTS, 1n);

/** A response that replaces the recorded one for the same request. */
const tampered = (name: string, edit: (result: Json) => void): RecordedCall => {
    const source = call(name);
    const response = clone(source.response) as { result: Json };
    edit(response.result);
    return { ...source, name: `tampered ${name}`, response: response as RecordedCall["response"] };
};

const flipHex = (hex: string, at: number) => {
    const bytes = Buffer.from(hex, "hex");
    bytes[at] ^= 0x01;
    return bytes.toString("hex");
};

async function rejection(promise: Promise<unknown>): Promise<GatewayVerificationError> {
    try {
        await promise;
    } catch (error) {
        expect(error).to.be.instanceOf(GatewayVerificationError);
        return error as GatewayVerificationError;
    }
    throw new Error("expected a GatewayVerificationError");
}

async function withReplay<T>(extra: RecordedCall[], use: (replay: Replay) => Promise<T>): Promise<T> {
    const replay = await startReplay(extra);
    try {
        return await use(replay);
    } finally {
        await replay.close();
    }
}

async function withClient<T>(
    extra: RecordedCall[],
    use: (client: GatewayClient) => Promise<T>,
    source: BatchSource | null = settlement,
    sends: SendSource | null = nodeOf({ [SEND]: RECORDED_SEND })
): Promise<T> {
    return withReplay(extra, async (replay) => {
        const client = await GatewayClient.connect(replay.url, { batches: source ?? undefined, sends: sends ?? undefined });
        try {
            return await use(client);
        } finally {
            client.close();
        }
    });
}

describe("gateway verification", () => {
    describe("a recorded contract read", () => {
        it("verifies its five proofs, the Settlement root and the derived paths", () =>
            withClient([], async (client) => {
                const read = await client.read(DOMAIN, VIEW, PARAMS);
                expect(read.check).to.deep.equal({ proofs: 5, rootChecked: true, pathsChecked: true });
            }));

        it("verifies an absent contract through absence proofs", () =>
            withClient([], async (client) => {
                const [domain, view, params] = call("read contract absent").params as [number, string, Record<string, unknown>];
                const read = await client.read(domain, view, params);
                expect(read.check).to.deep.equal({ proofs: 5, rootChecked: true, pathsChecked: true });
            }));

        it("verifies an absent storage key", () =>
            withClient([], async (client) => {
                const [domain, view, params] = call("read storage").params as [number, string, Record<string, unknown>];
                expect((await client.read(domain, view, params)).check.pathsChecked).to.equal(true);
            }));

        it("leaves rootChecked false without a Settlement source", () =>
            withClient([], async (client) => {
                const read = await client.read(DOMAIN, VIEW, PARAMS);
                expect(read.check).to.deep.equal({ proofs: 5, rootChecked: false, pathsChecked: true });
            }, null));

        it("reports a view without state proofs as not path checked", () =>
            withClient([], async (client) => {
                const [domain, view, params] = call("read contractsByDeployer").params as [number, string, Record<string, unknown>];
                const read = await client.read(domain, view, params);
                expect(read.check).to.deep.equal({ proofs: 0, rootChecked: true, pathsChecked: false });
            }));

        it("does not check the root of a result the gateway did not mark verified", () =>
            withClient([tampered("read contract", (r) => { r.verified = false; })], async (client) => {
                const read = await client.read(DOMAIN, VIEW, PARAMS);
                expect(read.check.rootChecked).to.equal(false);
                expect(read.verified).to.equal(false);
            }));
    });

    describe("tampering", () => {
        const readFails = async (edit: (r: Json) => void, check: string, detail?: RegExp) =>
            withClient([tampered("read contract", edit)], async (client) => {
                const error = await rejection(client.read(DOMAIN, VIEW, PARAMS));
                expect(error.check).to.equal(check);
                if (detail) expect(error.message).to.match(detail);
            });

        it("rejects a proof whose value was changed", () =>
            readFails((r) => { r.proofs[0].value = flipHex(r.proofs[0].value, 0); }, "inclusion proof"));

        it("rejects a proof whose bytes were changed", () =>
            readFails((r) => { r.proofs[0].proof = r.proofs[0].proof.slice(0, 200) + flipHex(r.proofs[0].proof.slice(200, 202), 0) + r.proofs[0].proof.slice(202); }, "inclusion proof"));

        it("rejects a different state root than the proofs commit to", () =>
            readFails((r) => { r.postStateRoot = flipHex(r.postStateRoot, 5); }, "inclusion proof"));

        it("rejects an inclusion proof sent as an absence proof", () =>
            readFails((r) => { r.proofs[3].present = true; r.proofs[3].value = "00"; }, "proof structure"));

        it("rejects a result field that the proven leaves do not give", () =>
            readFails((r) => { r.result.codeHash = flipHex(r.result.codeHash, 0); }, "path derivation", /codeHash/));

        it("rejects an upgrade policy that differs from the proven leaf", () =>
            readFails((r) => { r.result.upgradePolicy = "OWNER_UPGRADEABLE"; }, "path derivation", /upgradePolicy/));

        it("rejects proofs returned for other paths", () =>
            readFails((r) => { [r.proofs[0], r.proofs[1]] = [r.proofs[1], r.proofs[0]]; }, "path derivation"));

        it("rejects an owner address the proven leaf does not vouch for", () =>
            readFails((r) => { r.result.owner = "z1qxemdeddedxplasmaxxxxxxxxxxxxxxxxsctrp"; }, "path derivation", /owner/));

        it("rejects a state root that differs from Settlement's", () => {
            const wrong: BatchSource = async (domain, id) => {
                const entry = await settlement(domain, id);
                return entry && { ...entry, postStateRoot: Hash.parse(flipHex(entry.postStateRoot.toString(), 0)) };
            };
            return withClient([], async (client) => {
                const error = await rejection(client.read(DOMAIN, VIEW, PARAMS));
                expect(error.check).to.equal("batch root");
            }, wrong);
        });

        it("rejects a batch Settlement does not know", () =>
            withClient([], async (client) => {
                const error = await rejection(client.read(DOMAIN, VIEW, PARAMS));
                expect(error.check).to.equal("batch root");
            }, async () => null));

        it("rejects a finalized tag for a batch Settlement does not report as finalized", () => {
            const source = call("read contract");
            const finalized: RecordedCall = { ...source, name: "finalized read", params: [...source.params, "finalized"] };
            return withClient([finalized], async (client) => {
                const error = await rejection(client.read(DOMAIN, VIEW, PARAMS, "finalized"));
                expect(error.check).to.equal("finality");
            });
        });
    });

    describe("getProof", () => {
        const [domain, paths] = call("getProof").params as [number, string[]];

        it("verifies each proof", () =>
            withClient([], async (client) => {
                const proof = await client.getProof(domain, paths);
                expect(proof.check).to.deep.equal({ proofs: 1, rootChecked: true, pathsChecked: true });
            }));

        it("rejects proofs for a path that was not requested", () =>
            withClient([], async (client) => {
                const other = flipHex(paths[0], 0);
                const source = call("getProof");
                const swapped: RecordedCall = { ...source, params: [domain, [other]] };
                const error = await rejection(withReplayClient(swapped, (c) => c.getProof(domain, [other])));
                expect(error.check).to.equal("paths");
                void client;
            }));
    });

    describe("getBatch", () => {
        it("checks every commitment against Settlement", () =>
            withClient([], async (client) => {
                expect((await client.getBatch(1)).check.rootChecked).to.equal(true);
            }));

        it("rejects a commitment that differs from Settlement's", () =>
            withClient([tampered("getBatch latest", (r) => { r.receiptRoot = flipHex(r.receiptRoot, 2); })], async (client) => {
                const error = await rejection(client.getBatch(1));
                expect(error.check).to.equal("batch commitment");
                expect(error.message).to.match(/receiptRoot/);
            }));
    });

    describe("contracts profile", () => {
        it("reads the features and verified views", () =>
            withClient([], async (client) => {
                const contracts = await client.contracts(1);
                expect(contracts.features).to.deep.equal({
                    upgrade: true,
                    ownershipTransfer: true,
                    storageQuota: true,
                    payableCalls: true,
                    deposits: true,
                    nativeAddresses: false,
                });
                expect(contracts.interfaceEncodings).to.deep.equal(["zeno-selector-v1"]);
                const contract = await contracts.contract(PARAMS.contractId as string);
                expect(contract.result.upgradePolicy).to.equal("IMMUTABLE");
                expect(contract.check.pathsChecked).to.equal(true);
            }));

        it("returns a module that hashes to its source code hash", () =>
            withClient([], async (client) => {
                const contracts = await client.contracts(1);
                const [, , params] = call("read module").params as [number, string, { sourceCodeHash: string }];
                const module = await contracts.module(params.sourceCodeHash);
                expect(module.module.length).to.be.greaterThan(0);
                expect(Buffer.from(module.module).subarray(0, 4).toString("hex")).to.equal("0061736d");
            }));

        it("rejects a module whose bytes were changed", () =>
            withClient([tampered("read module", (r) => { r.result.module = flipHex(r.result.module, 10); })], async (client) => {
                const contracts = await client.contracts(1);
                const [, , params] = call("read module").params as [number, string, { sourceCodeHash: string }];
                const error = await rejection(contracts.module(params.sourceCodeHash));
                expect(error.check).to.equal("module hash");
            }));

        it("throws UnsupportedProfileError for a domain without contracts/1", () =>
            withClient([tampered("chainInfo", (r) => { r.profiles = []; })], async (client) => {
                let thrown: unknown;
                try {
                    await client.contracts(1);
                } catch (error) {
                    thrown = error;
                }
                expect(thrown).to.be.instanceOf(UnsupportedProfileError);
            }));

        it("refuses the native address views when the flag is unset", () =>
            withClient([], async (client) => {
                const contracts = await client.contracts(1);
                let thrown: unknown;
                try {
                    await contracts.resolveNativeAddress("z1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsggv2f");
                } catch (error) {
                    thrown = error;
                }
                expect(thrown).to.be.instanceOf(UnsupportedProfileError);
            }));
    });

    describe("verifyReceipt", () => {
        const OTHER_SEND = "05ee000000000000000000000000000000000000000000000000000000000000";
        const receipt = (): Json => clone(result("getReceipt success"));

        const verify = (
            edit: ((r: Json) => void) | null,
            extra: RecordedCall[] = [],
            source: BatchSource | null = settlement
        ) => {
            const r = receipt();
            edit?.(r);
            return withClient(extra, (client) => client.verifyReceipt(SEND, r as never), source);
        };
        const fails = (
            edit: ((r: Json) => void) | null, check: string, detail?: RegExp, extra: RecordedCall[] = [],
            sends: SendSource | null = nodeOf({ [SEND]: RECORDED_SEND }), source: BatchSource | null = settlement
        ) =>
            withClient(extra, async (client) => {
                const r = receipt();
                edit?.(r);
                const error = await rejection(client.verifyReceipt(SEND, r as never));
                expect(error.check).to.equal(check);
                if (detail) expect(error.message).to.match(detail);
            }, source, sends);
        const plain = async (promise: Promise<unknown>): Promise<Error> => {
            try {
                await promise;
            } catch (error) {
                expect(error).to.be.instanceOf(Error);
                expect(error).to.not.be.instanceOf(GatewayVerificationError);
                return error as Error;
            }
            throw new Error("expected an Error");
        };
        const pending = (r: Json) => { r.tag = "pending"; };
        const withDomain2 = () => nodeOf({ [SEND]: sendOf("DeployContractFinalize", [2, "0x" + RECORDED_CODE_HASH], ZNN_ZTS, 1n) });
        const withOtherSender = () => nodeOf({ [SEND]: { ...RECORDED_SEND, address: PLASMA_ADDRESS } });

        it("accepts the recorded receipt, including its decoded input, without reading the bundle", () =>
            withReplay([], async (replay) => {
                const node = counting(nodeOf({ [SEND]: RECORDED_SEND }));
                const client = await GatewayClient.connect(replay.url, { batches: settlement, sends: node.source });
                try {
                    expect(await client.verifyReceipt(SEND, receipt() as never)).to.equal(true);
                    expect(replay.requests.map((x) => x.method)).to.not.include("zeno_getBundle");
                    expect(node.seen).to.deep.equal([SEND]);
                } finally {
                    client.close();
                }
            }));

        it("rejects a finalized receipt for a batch Settlement does not report as finalized", () =>
            fails((r) => { r.tag = "finalized"; }, "finality"));

        it("accepts a finalized receipt for a finalized batch", async () => {
            const finalized: BatchSource = async () => entryOf(batches[0], true);
            expect(await verify((r) => { r.tag = "finalized"; }, [], finalized)).to.equal(true);
        });

        it("returns false for a pending receipt after one send read and no gateway request", () =>
            withReplay([], async (replay) => {
                const node = counting(nodeOf({ [SEND]: RECORDED_SEND }));
                const client = await GatewayClient.connect(replay.url, { sends: node.source });
                try {
                    const before = replay.requests.length;
                    const r = receipt();
                    pending(r);
                    expect(await client.verifyReceipt(SEND, r as never)).to.equal(false);
                    expect(replay.requests.length).to.equal(before);
                    expect(node.seen).to.deep.equal([SEND]);
                } finally {
                    client.close();
                }
            }));

        it("rejects a receipt for another send than the tracked one before any read", () =>
            withReplay([], async (replay) => {
                const batchReads = counting(settlement);
                const node = counting(nodeOf({ [SEND]: RECORDED_SEND }));
                const client = await GatewayClient.connect(replay.url, { batches: batchReads.source, sends: node.source });
                try {
                    const before = replay.requests.length;
                    const error = await rejection(client.verifyReceipt(OTHER_SEND, receipt() as never));
                    expect(error.check).to.equal("send binding");
                    expect(error.message).to.match(/receipt is for send "04ee/);
                    expect(replay.requests.length).to.equal(before);
                    expect(batchReads.seen).to.deep.equal([]);
                    expect(node.seen).to.deep.equal([]);
                } finally {
                    client.close();
                }
            }));

        it("rejects a tag that is not pending, latest or finalized", async () => {
            await fails((r) => { r.tag = "safe"; }, "receipt structure", /tag/);
            await fails((r) => { r.tag = "Latest"; }, "receipt structure", /tag/);
        });

        it("bounds a gateway string in the message", async () => {
            const error = await rejection(verify((r) => { r.tag = "x".repeat(5000); }));
            expect(error.check).to.equal("receipt structure");
            expect(error.message.length).to.be.lessThan(200);
        });

        it("rejects a receipt whose leaf commits another send's input", () =>
            withClient([], async (client) => {
                const r = receipt();
                r.sendHash = OTHER_SEND;
                const error = await rejection(client.verifyReceipt(OTHER_SEND, r as never));
                expect(error.check).to.equal("input hash");
                expect(error.message).to.match(/send "05ee/);
            }, settlement, nodeOf({ [OTHER_SEND]: RECORDED_SEND })));

        it("rejects a receipt field the Settlement-committed leaf does not give", async () => {
            await fails((r) => { r.receipt.status = "REVERT"; }, "receipt leaf", /status/);
            await fails((r) => { r.receipt.status = "success"; }, "receipt leaf", /status/);
            await fails((r) => { r.receipt.gasUsed = 1; }, "receipt leaf", /gasUsed/);
        });

        it("rejects return data the leaf's returnHash does not cover", async () => {
            await fails((r) => { r.returnData = flipHex(r.returnData, 40); }, "return hash");
            await fails((r) => { r.returnData = ""; }, "return hash");
            await fails((r) => { r.returnData += "0"; }, "receipt structure", /returnData/);
        });

        it("rejects a decoded input that differs from the input bytes", () =>
            fails((r) => { r.input.kind = "UpgradeContract"; }, "input", /kind/));

        it("rejects a sidecar that does not hash to Settlement's receiptRoot", async () => {
            const sidecar = tampered("getReceiptSidecar", (x) => { x.sidecar = flipHex(x.sidecar, 100); });
            await fails(null, "receipt root", undefined, [sidecar]);
        });

        it("rejects a truncated sidecar as a structure failure", async () => {
            const sidecar = tampered("getReceiptSidecar", (x) => { x.sidecar = x.sidecar.slice(0, -2); });
            await fails(null, "receipt structure", /sidecar/, [sidecar]);
        });

        it("rejects a send whose rebuilt input does not hash to the leaf's inputHash", () => {
            const flipped = flipHex(RECORDED_CODE_HASH, 0);
            return fails(null, "input hash", /does not hash to the leaf's inputHash/, [],
                nodeOf({ [SEND]: sendOf("DeployContractFinalize", [1, "0x" + flipped], ZNN_ZTS, 1n) }));
        });

        it("passes a missing sidecar through as NotFoundError, after both bindings", () =>
            withClient([syntheticError("zeno_getReceiptSidecar", [batches[0].daHash], -32004, "sidecar not found")], async (client) => {
                const error = await plain(client.verifyReceipt(SEND, receipt() as never));
                expect(error).to.be.instanceOf(NotFoundError);
            }));

        it("passes an error the send source throws through unchanged", () =>
            withClient([], async (client) => {
                const error = await plain(client.verifyReceipt(SEND, receipt() as never));
                expect(error.message).to.equal("node unreachable");
            }, settlement, async () => { throw new Error("node unreachable"); }));

        it("throws a plain error when the node has no block for the send, at latest and pending", async () => {
            for (const tag of ["latest", "pending"]) {
                await withReplay([], async (replay) => {
                    const batchReads = counting(settlement);
                    const client = await GatewayClient.connect(replay.url, { batches: batchReads.source, sends: nodeOf({}) });
                    try {
                        const before = replay.requests.length;
                        const r = receipt();
                        r.tag = tag;
                        const error = await plain(client.verifyReceipt(SEND, r as never));
                        expect(error.message).to.match(/no account block/);
                        expect(replay.requests.length).to.equal(before);
                        expect(batchReads.seen).to.deep.equal([]);
                    } finally {
                        client.close();
                    }
                });
            }
        });

        it("rejects a block that is not a UserSend to Settlement", async () => {
            const notSettlement = nodeOf({ [SEND]: { ...RECORDED_SEND, toAddress: PLASMA_ADDRESS } });
            const notUserSend = nodeOf({ [SEND]: { ...RECORDED_SEND, blockType: BlockTypeEnum.ContractSend } });
            await fails(null, "send block", /not a send to Settlement/, [], notSettlement);
            await fails(null, "send block", /not a send to Settlement/, [], notUserSend);
        });

        it("rejects call data that is not an input method or does not decode", async () => {
            await fails(null, "send block", /not an input method/, [], nodeOf({ [SEND]: sendOf("SubmitBatch", ["0x00"]) }));
            await fails(null, "send block", /does not decode/, [], nodeOf({ [SEND]: { ...RECORDED_SEND, data: new Uint8Array(0) } }));
            await fails(null, "send block", /does not decode/, [],
                nodeOf({ [SEND]: { ...RECORDED_SEND, data: RECORDED_SEND.data.subarray(0, RECORDED_SEND.data.length - 1) } }));
        });

        it("rejects a send whose call data names another domain than the receipt", () =>
            fails(null, "domain binding", /calls domain 2/, [], withDomain2()));

        it("rejects a send from another account than the receipt's sender", async () => {
            await fails(null, "sender binding", /not the receipt's sender/, [], withOtherSender());
            await fails((r) => { r.sender = PLASMA_ADDRESS.toString(); }, "sender binding", /not the receipt's sender/);
        });

        it("binds the domain and the sender of a pending receipt without any gateway request", async () => {
            const cases: [SendSource, string][] = [
                [withDomain2(), "domain binding"],
                [withOtherSender(), "sender binding"],
                [nodeOf({ [SEND]: { ...RECORDED_SEND, toAddress: PLASMA_ADDRESS } }), "send block"],
            ];
            for (const [node, check] of cases) {
                await withReplay([], async (replay) => {
                    const client = await GatewayClient.connect(replay.url, { sends: node });
                    try {
                        const r = receipt();
                        pending(r);
                        const error = await rejection(client.verifyReceipt(SEND, r as never));
                        expect(error.check).to.equal(check);
                        expect(replay.requests.length).to.equal(0);
                    } finally {
                        client.close();
                    }
                });
            }
        });

        it("binds the domain and the sender before it asks Settlement for the batch", async () => {
            const none: BatchSource = async () => null;
            await fails(null, "domain binding", undefined, [], withDomain2(), none);
            await fails(null, "sender binding", undefined, [], withOtherSender(), none);
        });

        it("rejects a pending receipt that lacks sender or whose sender is not a string", async () => {
            await fails((r) => { pending(r); delete r.sender; }, "receipt structure", /lacks sender/);
            await fails((r) => { pending(r); r.sender = 5; }, "receipt structure", /sender is not a string/);
        });

        it("rejects a batch Settlement does not know", () => withClient([], async (client) => {
            const error = await rejection(client.verifyReceipt(SEND, receipt() as never));
            expect(error.check).to.equal("batch root");
        }, async () => null));

        it("needs a batch source", () =>
            withClient([], async (client) => {
                const error = await plain(client.verifyReceipt(SEND, receipt() as never));
                expect(error.message).to.match(/needs a batch source/);
            }, null));

        it("needs a send source, at latest and pending", () =>
            withClient([], async (client) => {
                for (const edit of [null, pending]) {
                    const r = receipt();
                    edit?.(r);
                    const error = await plain(client.verifyReceipt(SEND, r as never));
                    expect(error.message).to.match(/needs a send source/);
                }
            }, settlement, null));

        it("rejects a result that is not an object as a structure failure", async () => {
            await fails((r) => { r.receipt = null; }, "receipt structure", /receipt/);
            const error = await rejection(withClient([], (client) => client.verifyReceipt(SEND, null as never)));
            expect(error.check).to.equal("receipt structure");
        });

        it("rejects keys the check did not verify on the result", () =>
            fails((r) => { r.decoded = "Settlement confirmed"; }, "receipt structure", /unexpected key "decoded"/));

        describe("events and outbox items built from the serialization suite", () => {
            const suite: { vectors: Json[] } = JSON.parse(
                readFileSync(new URL("../fixtures/serialization-conformance-v1.json", import.meta.url), "utf8")
            );
            const vector = (id: string): Json => {
                const v = suite.vectors.find((x) => x.id === id);
                if (!v) throw new Error(`missing vector ${id}`);
                return v;
            };
            const ZERO = new Uint8Array(32);
            const zeroHash = new Hash(Buffer.alloc(32));
            const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
            const suiteInput = Uint8Array.from(Buffer.from(vector("CV-INPUTROOT-1").inputs[0].encoded_hex, "hex"));
            const suiteInputs: string[] = vector("CV-INPUTROOT-1").inputs.map((x: Json) => x.encoded_hex);
            const sendHash = hex(suiteInput.subarray(1, 33));

            /** The tail fields of the eight input kinds of CV-INPUTROOT-1, in the reader's JSON form. */
            const wanted: Json[] = [
                { kind: "CallL2", inputKind: 0, targetContract: "11".repeat(32), plasmaLimit: 100, depositAsset: "0000000000000000000000000000000000000000000014e66318c6318c6318c6", depositAmount: "1", payload: "63616c6c" },
                { kind: "Deposit", inputKind: 1, targetContract: "13".repeat(32), plasmaLimit: 200, depositAsset: "0000000000000000000000000000000000000000000004066318c6318c6318c6", depositAmount: "2" },
                { kind: "DeployContractStart", inputKind: 2, codeHash: "15".repeat(32), metadataHash: "3b552fdc9b613ed4cc2668f65e6ede473caa412b1506deb0706848e7613ffa4f", totalSize: 4096, chunkCount: 2, metadata: "0001000000000000000000000000000000000000000000" },
                { kind: "DeployContractChunk", inputKind: 3, codeHash: "18".repeat(32), chunkIndex: 0, chunkHash: "19".repeat(32) },
                { kind: "DeployContractFinalize", inputKind: 4, codeHash: "1b".repeat(32) },
                { kind: "UpgradeContract", inputKind: 5, contractId: "1d".repeat(32), newCodeHash: "1e".repeat(32) },
                { kind: "TransferContractOwnership", inputKind: 6, contractId: "20".repeat(32), newOwner: "z1yysjzgfpyysjzgfpyysjzgfpyysjzgfpu0uju6" },
                { kind: "BuyStorage", inputKind: 7, contractId: "23".repeat(32), bytes: 4096 },
            ];
            const h0x = (x: string) => "0x" + x;
            const assetStandard = (asset: string) => sdkSettlement.ztsFromAssetId(Hash.parse(asset));
            /** The L1 send behind each input of CV-INPUTROOT-1, in domain 1. */
            const SUITE_SENDS: SendBlock[] = [
                sendOf("CallL2", [1, h0x(wanted[0].targetContract), 100n, h0x(wanted[0].payload)], assetStandard(wanted[0].depositAsset), 1n),
                sendOf("Deposit", [1, h0x(wanted[1].targetContract), 200n], assetStandard(wanted[1].depositAsset), 2n),
                sendOf("DeployContractStart", [1, h0x(wanted[2].codeHash), h0x(wanted[2].metadataHash), 4096n, 2, h0x(wanted[2].metadata)]),
                sendOf("DeployContractChunk", [1, h0x(wanted[3].codeHash), 0, h0x(wanted[3].chunkHash), "0x00"]),
                sendOf("DeployContractFinalize", [1, h0x(wanted[4].codeHash)], ZNN_ZTS, 1n),
                sendOf("UpgradeContract", [1, h0x(wanted[5].contractId), h0x(wanted[5].newCodeHash)], ZNN_ZTS, 1n),
                sendOf("TransferContractOwnership", [1, h0x(wanted[6].contractId), wanted[6].newOwner]),
                sendOf("BuyStorage", [1, h0x(wanted[7].contractId), 4096n], ZNN_ZTS, 1n),
            ];

            /** One domain 1, batch 9 around the ExecutionResult of a suite vector. */
            const builtBatch = (
                id: string,
                shape: { leafBatch?: bigint; twice?: boolean; input?: number; status?: number; send?: SendBlock; encoded?: Uint8Array } = {}
            ) => {
                const encoded: string = vector(id).encoded_hex;
                const input = shape.encoded ?? Uint8Array.from(Buffer.from(suiteInputs[shape.input ?? 0], "hex"));
                const sendHash = hex(input.subarray(1, 33));
                const send = shape.send ?? SUITE_SENDS[shape.input ?? 0];
                const decoded = decodeExecutionResult(Uint8Array.from(Buffer.from(encoded, "hex")));
                const I = decoded.globalInputIndex;
                const inSuite = (bytes: Uint8Array) => {
                    expect(encoded).to.contain(hex(bytes));
                    return bytes;
                };

                const eventBytes = decoded.events.map((e) =>
                    inSuite(new ZenoWriter().bytes32(e.contractId.getBytes()).u64(e.inputIndex).u32(e.eventIndex)
                        .list(e.topics, (w, t) => w.bytes32(t.getBytes())).bytes(e.data).finish()));
                const outboxBytes = decoded.outbox.map((m) => {
                    const w = new ZenoWriter().bytes32(m.sourceContract.getBytes()).u64(m.inputIndex).u32(m.outboxIndex);
                    if (m.kind === OutboxKind.L2_DELIVERY) {
                        w.u8(m.kind).bytes32(m.targetContract.getBytes());
                    } else {
                        w.u8(m.kind).address(m.recipient.getBytes()).bytes32(m.assetId.getBytes()).u256(m.amount);
                    }
                    return inSuite(w.bytes(m.payload).finish());
                });

                const returnHash = decoded.returnData.length === 0 ? ZERO : sha3(decoded.returnData);
                const leaf = new ZenoWriter().u16(1).u64(I).bytes32(sha3(input)).u64(shape.leafBatch ?? 9n)
                    .bytes32(ZERO).bytes32(ZERO).u8(shape.status ?? ReceiptStatus.SUCCESS).u64(1000n).i32(0).bytes32(ZERO)
                    .bytes32(returnHash).bytes32(merkleRoot(eventBytes).getBytes()).u32(eventBytes.length)
                    .bytes32(merkleRoot(outboxBytes).getBytes()).u32(outboxBytes.length).finish();
                const leaves = shape.twice ? [leaf, leaf] : [leaf];
                const sidecar = new ZenoWriter().list(leaves, (w, l) => w.bytes(l)).finish();
                const daHash = hex(sha3(sidecar));
                const entry: SettlementBatchEntry = {
                    preStateRoot: zeroHash, postStateRoot: zeroHash, inputRoot: zeroHash,
                    receiptRoot: merkleRoot(leaves), eventRoot: zeroHash, outboxRoot: zeroHash,
                    daHash: Hash.parse(daHash), isFinalized: false,
                };
                const reply = (method: string, field: string, value: string): RecordedCall => ({
                    name: `built ${method}`,
                    method,
                    params: [daHash],
                    response: { jsonrpc: "2.0", id: 1, result: { domainId: 1, batchId: 9, verified: true, daHash, [field]: value } },
                });
                const sends = nodeOf({ [sendHash]: send });

                const inputBytes = (from: number, to: number) => hex(input.subarray(from, to));
                const receipt: Json = {
                    domainId: 1, batchId: 9, verified: true, tag: "latest", globalInputIndex: Number(I), sendHash,
                    sender: SENDER,
                    receipt: {
                        inputIndex: Number(I), inputHash: hex(sha3(input)), batchId: 9, contractId: hex(ZERO), codeHash: hex(ZERO),
                        status: "SUCCESS", gasUsed: 1000, abortCode: 0, stateDiffHash: hex(ZERO), returnHash: hex(returnHash),
                        eventRoot: merkleRoot(eventBytes).toString(), eventCount: eventBytes.length,
                        outboxRoot: merkleRoot(outboxBytes).toString(), outboxCount: outboxBytes.length,
                    },
                    returnData: hex(decoded.returnData),
                    events: decoded.events.map((e) => ({
                        contractId: e.contractId.toString(), inputIndex: Number(e.inputIndex), eventIndex: e.eventIndex,
                        topics: e.topics.map((t) => t.toString()), data: hex(e.data),
                    })),
                    outbox: decoded.outbox.map((m) => ({
                        outboxId: sdkSettlement.outboxId(1, 9n, m.inputIndex, m.outboxIndex).toString(),
                        sourceContract: m.sourceContract.toString(), inputIndex: Number(m.inputIndex), outboxIndex: m.outboxIndex,
                        kind: m.kind === OutboxKind.L2_DELIVERY ? "L2_DELIVERY" : "L1_WITHDRAWAL",
                        targetContract: m.kind === OutboxKind.L2_DELIVERY ? m.targetContract.toString() : null,
                        recipient: m.kind === OutboxKind.L1_WITHDRAWAL ? m.recipient.toString() : null,
                        assetId: m.kind === OutboxKind.L1_WITHDRAWAL ? m.assetId.toString() : null,
                        amount: m.kind === OutboxKind.L1_WITHDRAWAL ? m.amount.toString() : null,
                        payload: hex(m.payload),
                    })),
                    input: {
                        kind: "CallL2", inputKind: 0, sourceAccountBlockHash: inputBytes(1, 33),
                        targetContract: inputBytes(33, 65), plasmaLimit: 100, depositAsset: inputBytes(73, 105),
                        depositAmount: "1", payload: "63616c6c",
                    },
                };
                const source: BatchSource = async () => entry;
                const extra = [reply("zeno_getReceiptSidecar", "sidecar", hex(sidecar))];
                return { receipt, source, extra, sendHash, sends };
            };

            const check = (id: string, edit?: (r: Json) => void, shape?: Parameters<typeof builtBatch>[1]) => {
                const { receipt, source, extra, sends } = builtBatch(id, shape);
                edit?.(receipt);
                return withClient(extra, (client) => client.verifyReceipt(sendHash, receipt as never), source, sends);
            };
            const checkFails = async (
                id: string, edit: (r: Json) => void, name: string, detail?: RegExp, shape?: Parameters<typeof builtBatch>[1]
            ) => {
                const error = await rejection(check(id, edit, shape));
                expect(error.check).to.equal(name);
                if (detail) expect(error.message).to.match(detail);
            };
            const ZERO_ADDRESS = SENDER;

            it("accepts a receipt with an event and an outbox item, and one with 33 outbox items", async () => {
                expect(await check("CV-RESULT-1")).to.equal(true);
                expect(await check("CV-RESULT-OUTBOX-1")).to.equal(true);
            });

            it("rejects events that differ from the leaf's eventRoot", async () => {
                await checkFails("CV-RESULT-1", (r) => { r.events[0].data = flipHex(r.events[0].data, 0); }, "event root");
                await checkFails("CV-RESULT-1", (r) => { r.events[0].topics[0] = flipHex(r.events[0].topics[0], 0); }, "event root");
                await checkFails("CV-RESULT-1", (r) => { r.events = []; }, "event root");
            });

            it("rejects outbox items that differ from the leaf's outboxRoot", async () => {
                await checkFails("CV-RESULT-1", (r) => { r.outbox[0].targetContract = flipHex(r.outbox[0].targetContract, 0); }, "outbox root");
                await checkFails("CV-RESULT-1", (r) => { r.outbox[0].payload = flipHex(r.outbox[0].payload, 0); }, "outbox root");
                await checkFails("CV-RESULT-1", (r) => { r.outbox = []; }, "outbox root");
                await checkFails("CV-RESULT-1", (r) => { r.outbox[0].recipient = ZERO_ADDRESS; }, "outbox root", /carries recipient/);
            });

            it("rejects a refund or an outbox item the gateway altered", async () => {
                const last = (r: Json) => r.outbox[r.outbox.length - 1];
                await checkFails("CV-RESULT-OUTBOX-1", (r) => { last(r).amount = String(BigInt(last(r).amount) + 1n); }, "outbox root");
                await checkFails("CV-RESULT-OUTBOX-1", (r) => { last(r).recipient = ZERO_ADDRESS; }, "outbox root");
                await checkFails("CV-RESULT-OUTBOX-1", (r) => { last(r).amount = "0x" + BigInt(last(r).amount).toString(16); }, "receipt structure", /amount/);
                await checkFails("CV-RESULT-OUTBOX-1", (r) => { r.outbox[0].outboxId = flipHex(r.outbox[0].outboxId, 0); }, "outbox id");
                await checkFails("CV-RESULT-OUTBOX-1", (r) => { r.outbox[0].kind = "L3_SOMETHING"; }, "outbox root", /unknown kind/);
            });

            it("rejects return data the leaf's returnHash does not cover", () =>
                checkFails("CV-RESULT-1", (r) => { r.returnData = "05"; }, "return hash"));

            it("rejects an event, an outbox item or a result with a key the check did not verify", async () => {
                await checkFails("CV-RESULT-1", (r) => { r.events[0].name = "Transfer"; }, "receipt structure", /event 0 has unexpected key "name"/);
                await checkFails("CV-RESULT-1", (r) => { r.outbox[0].refund = "1"; }, "receipt structure", /outbox item 0 has unexpected key "refund"/);
                await checkFails("CV-RESULT-1", (r) => { r.decoded = {}; }, "receipt structure", /unexpected key "decoded"/);
                await checkFails("CV-RESULT-1", (r) => { delete r.sender; }, "receipt structure", /lacks sender/);
            });

            it("rejects events or outbox that are not lists, and an item that is not an object or lacks a key", async () => {
                await checkFails("CV-RESULT-1", (r) => { (r as { events: unknown }).events = "x"; }, "receipt structure", /events is not a list/);
                await checkFails("CV-RESULT-1", (r) => { (r as { outbox: unknown }).outbox = {}; }, "receipt structure", /outbox is not a list/);
                await checkFails("CV-RESULT-1", (r) => { (r.events as unknown[])[0] = null; }, "receipt structure", /event 0 is not an object/);
                await checkFails("CV-RESULT-1", (r) => { delete (r.events[0] as { data?: string }).data; }, "receipt structure", /event 0 lacks data/);
                await checkFails("CV-RESULT-1", (r) => { delete (r.outbox[0] as { payload?: string }).payload; }, "receipt structure", /outbox item 0 lacks payload/);
            });

            it("rejects topics that are not a list", () =>
                checkFails("CV-RESULT-1", (r) => { r.events[0].topics = ""; }, "receipt structure", /topics is not a list/));

            it("bounds a gateway outbox kind in the message", async () => {
                const kind = "x".repeat(5000);
                const error = await rejection(check("CV-RESULT-1", (r) => { r.outbox[0].kind = kind; }));
                expect(error.check).to.equal("outbox root");
                expect(error.message.length).to.be.lessThan(200);
            });

            it("escapes bidi controls in a gateway outbox kind", async () => {
                const error = await rejection(check("CV-RESULT-1", (r) => { r.outbox[0].kind = "\u202eL2"; }));
                expect(error.message).to.contain("\\u202e");
                expect(error.message).to.not.contain("\u202e");
            });

            it("rejects a leaf whose status has no name", async () => {
                const error = await rejection(check("CV-RESULT-1", (r) => { r.receipt.status = null; }, { status: 9 }));
                expect(error.check).to.equal("receipt leaf");
                expect(error.message).to.match(/status 9 has no name/);
            });

            it("rejects a null sidecar result as a structure failure", async () => {
                const { receipt, source, extra, sends } = builtBatch("CV-RESULT-1");
                (extra[0].response as { result: unknown }).result = null;
                const error = await rejection(withClient(extra, (client) => client.verifyReceipt(sendHash, receipt as never), source, sends));
                expect(error.check).to.equal("receipt structure");
                expect(error.message).to.match(/sidecar/);
            });

            it("accepts the decoded input of each of the eight input kinds from its send", async () => {
                expect(suiteInputs).to.have.length(wanted.length);
                for (const [index, tail] of wanted.entries()) {
                    const { receipt, source, extra, sends, sendHash: send } = builtBatch("CV-RESULT-1", { input: index });
                    expect(receipt.receipt.inputHash, `kind ${index} leaf`).to.equal(vector("CV-INPUTROOT-1").inputs[index].input_hash_hex);
                    receipt.input = { kind: tail.kind, inputKind: tail.inputKind, sourceAccountBlockHash: send, ...tail };
                    expect(await withClient(extra, (client) => client.verifyReceipt(send, receipt as never), source, sends), `kind ${index}`)
                        .to.equal(true);
                }
            });

            it("describes a deposit of amount 0 as zero32 and 0 whatever token standard the send names", async () => {
                const send = "10".repeat(32);
                const encoded = encodeInput(Hash.parse(send), {
                    kind: InputKind.CALL_L2, targetContract: Hash.parse("11".repeat(32)), plasmaLimit: 100n,
                    payload: Uint8Array.from(Buffer.from("63616c6c", "hex")),
                    depositAsset: zeroHash, depositAmount: 0n,
                });
                const call2 = (amount: bigint) => sendOf("CallL2", [1, h0x("11".repeat(32)), 100n, "0x63616c6c"], ZNN_ZTS, amount);
                const run = (amount: bigint) => {
                    const { receipt, source, extra, sends } = builtBatch("CV-RESULT-1", { encoded, send: call2(amount) });
                    receipt.input = null;
                    return withClient(extra, (client) => client.verifyReceipt(send, receipt as never), source, sends);
                };
                expect(await run(0n)).to.equal(true);
                const error = await rejection(run(1n));
                expect(error.check).to.equal("input hash");
            });

            it("rejects a decoded CallL2 input whose payload differs from the input bytes", () =>
                checkFails("CV-RESULT-1", (r) => { r.input.payload = "63616c6d"; }, "input", /payload/));

            it("rejects an outbox item that lacks a field its kind uses", async () => {
                const last = (r: Json) => r.outbox[r.outbox.length - 1];
                await checkFails("CV-RESULT-1", (r) => { r.outbox[0].targetContract = null; }, "outbox root", /lacks targetContract/);
                await checkFails("CV-RESULT-OUTBOX-1", (r) => { last(r).recipient = null; }, "outbox root", /lacks recipient/);
                await checkFails("CV-RESULT-OUTBOX-1", (r) => { last(r).assetId = null; }, "outbox root", /lacks assetId/);
                await checkFails("CV-RESULT-OUTBOX-1", (r) => { last(r).amount = null; }, "outbox root", /lacks amount/);
            });

            it("rejects a recipient that is not the canonical address string", () =>
                checkFails("CV-RESULT-OUTBOX-1", (r) => {
                    const last = r.outbox[r.outbox.length - 1];
                    last.recipient = last.recipient.toUpperCase();
                }, "receipt structure", /canonical address/));

            it("rejects an amount given as a JSON number", () =>
                checkFails("CV-RESULT-OUTBOX-1", (r) => {
                    const last = r.outbox[r.outbox.length - 1];
                    last.amount = Number(last.amount);
                }, "receipt structure", /amount/));

            it("rejects an amount that is not a canonical decimal", async () => {
                const last = (r: Json) => r.outbox[r.outbox.length - 1];
                await checkFails("CV-RESULT-OUTBOX-1", (r) => { last(r).amount = " " + last(r).amount; }, "receipt structure", /amount/);
                await checkFails("CV-RESULT-OUTBOX-1", (r) => { last(r).amount = ""; }, "receipt structure", /amount/);
                await checkFails("CV-RESULT-OUTBOX-1", (r) => { last(r).amount = "0" + last(r).amount; }, "receipt structure", /amount/);
            });

            it("caps the error message for an amount above 2^256-1", async () => {
                const error = await rejection(check("CV-RESULT-OUTBOX-1", (r) => {
                    r.outbox[r.outbox.length - 1].amount = "9".repeat(500);
                }));
                expect(error.check).to.equal("receipt structure");
                expect(error.message.length).to.be.below(300);
            });

            it("rejects malformed hex and integers as a structure failure", async () => {
                await checkFails("CV-RESULT-1", (r) => { r.events[0].data += "zz"; }, "receipt structure", /data/);
                await checkFails("CV-RESULT-1", (r) => { r.events[0].data += "0"; }, "receipt structure", /data/);
                await checkFails("CV-RESULT-1", (r) => { r.events[0].data = r.events[0].data.toUpperCase() + "AB"; }, "receipt structure", /data/);
                await checkFails("CV-RESULT-1", (r) => { r.events[0].topics[0] = r.events[0].topics[0].slice(2); }, "receipt structure", /topic/);
                await checkFails("CV-RESULT-1", (r) => { r.events[0].contractId += "00"; }, "receipt structure", /contractId/);
                await checkFails("CV-RESULT-1", (r) => { r.events[0].eventIndex = -1; }, "receipt structure", /eventIndex/);
                await checkFails("CV-RESULT-1", (r) => { r.events[0].eventIndex = 0.5; }, "receipt structure", /eventIndex/);
                await checkFails("CV-RESULT-1", (r) => { r.outbox[0].inputIndex = "0"; }, "receipt structure", /inputIndex/);
                await checkFails("CV-RESULT-1", (r) => { r.outbox[0].payload += "0"; }, "receipt structure", /payload/);
            });

            it("rejects a domain, batch or input index that is not a non-negative integer", async () => {
                await checkFails("CV-RESULT-1", (r) => { r.globalInputIndex = -1; }, "receipt structure", /globalInputIndex/);
                await checkFails("CV-RESULT-1", (r) => { r.batchId = 9.5; }, "receipt structure", /batchId/);
                await checkFails("CV-RESULT-1", (r) => { r.domainId = "1"; }, "receipt structure", /domainId/);
            });

            it("rejects a receipt whose values, types or keys differ from the leaf's", async () => {
                await checkFails("CV-RESULT-1", (r) => { r.receipt.gasUsed = "1000"; }, "receipt leaf", /gasUsed/);
                await checkFails("CV-RESULT-1", (r) => { r.receipt.eventCount += 1; }, "receipt leaf", /eventCount/);
                await checkFails("CV-RESULT-1", (r) => { r.receipt.outboxCount += 1; }, "receipt leaf", /outboxCount/);
                await checkFails("CV-RESULT-1", (r) => { delete r.receipt.abortCode; }, "receipt leaf", /abortCode/);
                await checkFails("CV-RESULT-1", (r) => { r.receipt.extra = 1; }, "receipt leaf", /extra/);
            });

            it("accepts a send hash in upper case", async () => {
                const { receipt, source, extra, sends } = builtBatch("CV-RESULT-1");
                expect(await withClient(extra, (client) => client.verifyReceipt(sendHash.toUpperCase() as never, receipt as never), source, sends))
                    .to.equal(true);
            });

            it("rejects a sidecar that holds two receipts for the input", () =>
                checkFails("CV-RESULT-1", () => undefined, "receipt leaf", /2 receipts/, { twice: true }));

            it("rejects a leaf that names another batch", () =>
                checkFails("CV-RESULT-1", () => undefined, "receipt leaf", /names batch 8/, { leafBatch: 8n }));

            it("accepts a receipt that carries no decoded input", async () => {
                expect(await check("CV-RESULT-1", (r) => { r.input = null; })).to.equal(true);
            });

            it("rejects trailing bytes after the sidecar list", async () => {
                const { receipt, source, extra, sends } = builtBatch("CV-RESULT-1");
                const sidecar = extra[0].response as { result: Json };
                sidecar.result.sidecar += "00";
                const error = await rejection(withClient(extra, (client) => client.verifyReceipt(sendHash, receipt as never), source, sends));
                expect(error.check).to.equal("receipt structure");
                expect(error.message).to.match(/sidecar/);
            });
        });
    });
});

async function withReplayClient<T>(extra: RecordedCall, use: (client: GatewayClient) => Promise<T>): Promise<T> {
    return withClient([extra], use);
}

describe("error messages that quote hostile input", () => {
    const HOSTILE = "‮" + "a".repeat(200);
    const bounded = (error: Error) => {
        expect(error.message).to.not.include("‮");
        expect(error.message).to.not.include("a".repeat(100));
        expect(error.message.length).to.be.below(300);
    };

    it("refuses a send hash that is not 32 bytes of hex before any request", () =>
        withReplay([], async (replay) => {
            const client = await GatewayClient.connect(replay.url, { batches: settlement });
            try {
                const before = replay.requests.length;
                for (const hash of [HOSTILE, "04ee", "zz".repeat(32)]) {
                    let caught: unknown;
                    try {
                        await client.verifyReceipt(hash, clone(result("getReceipt success")) as never);
                    } catch (error) {
                        caught = error;
                    }
                    expect(caught).to.be.instanceOf(RangeError);
                    bounded(caught as Error);
                }
                expect(replay.requests.length).to.equal(before);
            } finally {
                client.close();
            }
        }));

    it("escapes and caps a proof path", () =>
        withClient([tampered("read contract", (r) => { r.proofs[0].path = HOSTILE; })], async (client) => {
            const error = await rejection(client.read(DOMAIN, VIEW, PARAMS));
            expect(error.check).to.equal("hash format");
            bounded(error);
        }));

    it("escapes and caps a batch id that Settlement does not know", () =>
        withClient([tampered("read contract", (r) => { r.batchId = HOSTILE; })], async (client) => {
            const error = await rejection(client.read(DOMAIN, VIEW, PARAMS));
            expect(error.check).to.equal("batch root");
            bounded(error);
        }));

    it("escapes and caps a batch id that differs from Settlement's", () => {
        const source: BatchSource = async () => ({ ...entryOf(batches[0]), postStateRoot: Hash.parse(flipHex(batches[0].postStateRoot, 0)) });
        return withClient([tampered("read contract", (r) => { r.batchId = HOSTILE; })], async (client) => {
            const error = await rejection(client.read(DOMAIN, VIEW, PARAMS));
            expect(error.check).to.equal("batch root");
            expect(error.message).to.include("differs from Settlement's");
            bounded(error);
        }, source);
    });

    it("escapes and caps a batch id that Settlement does not report as finalized in a read", () => {
        const source = call("read contract");
        const finalized: RecordedCall = {
            ...tampered("read contract", (r) => { r.batchId = HOSTILE; }),
            params: [...source.params, "finalized"],
        };
        return withClient([finalized], async (client) => {
            const error = await rejection(client.read(DOMAIN, VIEW, PARAMS, "finalized"));
            expect(error.check).to.equal("finality");
            bounded(error);
        }, async () => ({ ...entryOf(batches[0]), postStateRoot: Hash.parse(result("read contract").postStateRoot) }));
    });

    it("escapes and caps a batch id that Settlement does not report as finalized in a getBatch", () => {
        const source = call("getBatch latest");
        const finalized: RecordedCall = {
            ...tampered("getBatch latest", (r) => { r.batchId = HOSTILE; }),
            params: [source.params[0], "finalized"],
        };
        return withClient([finalized], async (client) => {
            const error = await rejection(client.getBatch(1, "finalized"));
            expect(error.check).to.equal("finality");
            bounded(error);
        }, async () => entryOf(batches[3]));
    });

    it("escapes and caps a contract owner that is not an address", () => {
        const id = Hash.parse("11".repeat(32));
        const keys = [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5]].map((k) => smtKey(id, Uint8Array.from(k)));
        const ownerCaller = new Uint8Array(32).fill(7);
        const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
        const leaves = keys.map((key, i) => ({ path: key.toString(), value: i === 3 ? ownerCaller : null }));
        const read = {
            result: { codeHash: null, sourceCodeHash: null, upgradePolicy: null, ownerCaller: toHex(ownerCaller), quota: null, owner: HOSTILE },
        } as unknown as ReadResult;
        let caught: unknown;
        try {
            wasmPathDerivation.verifyView("contract", { contractId: id.toString() }, read, leaves);
        } catch (error) {
            caught = error;
        }
        expect(caught).to.be.instanceOf(GatewayVerificationError);
        expect((caught as GatewayVerificationError).check).to.equal("path derivation");
        expect((caught as Error).message).to.include("the owner is not an address");
        bounded(caught as Error);
    });

    it("escapes and caps a code hash of the contract result", () =>
        withClient([tampered("read contract", (r) => { r.result.codeHash = HOSTILE; })], async (client) => {
            const error = await rejection(client.read(DOMAIN, VIEW, PARAMS));
            expect(error.check).to.equal("path derivation");
            bounded(error);
        }));

    describe("a value shaped like an array-like object", () => {
        const HUGE = { length: 500_000_000 };
        const quickly = async (promise: Promise<unknown>) => {
            const started = Date.now();
            const error = await rejection(promise);
            expect(Date.now() - started).to.be.below(2000);
            return error;
        };

        it("refuses a proof that is not a hex string before allocating", () =>
            withClient([tampered("read contract", (r) => { r.proofs[0].proof = HUGE; })], async (client) => {
                const error = await quickly(client.read(DOMAIN, VIEW, PARAMS));
                expect(error.check).to.equal("proof structure");
            }));

        it("refuses a proven value that is not a hex string before allocating", () =>
            withClient([tampered("read contract", (r) => { r.proofs[0].value = HUGE; })], async (client) => {
                const error = await quickly(client.read(DOMAIN, VIEW, PARAMS));
                expect(error.check).to.equal("proof structure");
            }));

        it("refuses a module that is not a hex string before allocating", () => {
            const hostile: RecordedCall = {
                ...tampered("read module", (r) => { r.result.module = HUGE; }),
            };
            return withClient([hostile], async (client) => {
                const contracts = await client.contracts(1);
                const params = call("read module").params[2] as { sourceCodeHash: string };
                const error = await quickly(contracts.module(params.sourceCodeHash));
                expect(error.check).to.equal("module hash");
            });
        });
    });

    it("escapes and caps a batch id in a getBatch result", () =>
        withClient([tampered("getBatch latest", (r) => { r.batchId = HOSTILE; })], async (client) => {
            const error = await rejection(client.getBatch(1));
            bounded(error);
        }, async () => entryOf({ ...batches[3], receiptRoot: flipHex(batches[3].receiptRoot, 0) })));

    it("escapes and caps the message of a gateway error", () => {
        const mapped = mapGatewayError({ code: -32004, message: HOSTILE }, "zeno_getBundle") as NotFoundError;
        expect(mapped).to.be.instanceOf(NotFoundError);
        bounded(mapped);
    });

    it("escapes and caps a source code hash that does not match", () => {
        const hostile: RecordedCall = {
            ...tampered("read module", () => undefined),
            params: [1, "module", { sourceCodeHash: HOSTILE }],
        };
        return withClient([hostile], async (client) => {
            const contracts = await client.contracts(1);
            const error = await rejection(contracts.module(HOSTILE));
            expect(error.check).to.equal("module hash");
            bounded(error);
        });
    });
});
