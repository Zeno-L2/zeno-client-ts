import { Address, BlockTypeEnum, Hash, SETTLEMENT_ADDRESS, SettlementContract, TokenStandard, settlement, state } from "znn-typescript-sdk";
import { ZenoCodecError, ZenoReader, ZenoWriter } from "../codec.js";
import { InputKind, ReceiptStatus } from "../constants.js";
import { OutboxKind, decodeReceipt } from "../decode.js";
import { hexToBytes } from "../bytes.js";
import { sha3 } from "../derive.js";
import { bounded, show } from "../format.js";
import { encodeInput, merkleRoot } from "../input.js";
import type { CanonicalInput } from "../input.js";
import { GatewayVerificationError } from "./errors.js";
import type { GatewayClient } from "./client.js";
import type { Batch, EventJson, Hex, OutboxJson, PathProof, ReadResult, ReceiptResult, Tag } from "./types.js";

/** What Settlement records about one batch. `SettlementBatch` from znn-typescript-sdk satisfies it. */
export interface SettlementBatchEntry {
    preStateRoot: Hash;
    postStateRoot: Hash;
    inputRoot: Hash;
    receiptRoot: Hash;
    eventRoot: Hash;
    outboxRoot: Hash;
    daHash: Hash;
    isFinalized: boolean;
}

/**
 * Reads a batch entry from Settlement, for example
 * `(domainId, batchId) => zenon.embedded.settlement.getBatch(domainId, batchId)`.
 */
export type BatchSource = (domainId: number, batchId: number) => Promise<SettlementBatchEntry | null>;

/** The fields of an L1 account block the receipt check reads. `AccountBlock` from znn-typescript-sdk satisfies it. */
export interface SendBlock {
    blockType: number;
    address: Address;
    toAddress: Address;
    tokenStandard: TokenStandard;
    amount: bigint | number | string;
    data: Uint8Array;
}

/**
 * Reads an account block by hash from the node the batch source reads,
 * for example `(hash) => zenon.ledger.getAccountBlockByHash(hash)`.
 */
export type SendSource = (hash: Hash) => Promise<SendBlock | null>;

/** What the client checked on a result. A check that did not run is `false`, never assumed. */
export interface VerificationReport {
    /** Proofs verified against `postStateRoot`. */
    proofs: number;
    /** `postStateRoot` equals the root Settlement records for the batch. */
    rootChecked: boolean;
    /** Each returned path equals the path the runtime derives, and the result matches the proven values. */
    pathsChecked: boolean;
}

export type Verified<T> = T & { check: VerificationReport };

/** A leaf whose proof verified. A null value is an absent key. */
export interface ProvenLeaf {
    path: Hex;
    value: Uint8Array | null;
}

const fromHex = (hex: unknown): Uint8Array => hexToBytes(hex, "a hex field", (detail) => new ZenoCodecError(detail));
export const toHex = (bytes: Uint8Array): Hex => Buffer.from(bytes).toString("hex");

/** The gateway's result as a record. Anything else is a failed structure check. */
export function requireRecord<T>(method: string, value: unknown, what = "result"): T {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new GatewayVerificationError(method, "result structure", `${what} is not an object`);
    }
    return value as T;
}

/** The proofs of a result as a list of records. Anything else is a failed structure check. */
export function requireProofs(method: string, proofs: unknown): PathProof[] {
    if (!Array.isArray(proofs)) {
        throw new GatewayVerificationError(method, "result structure", "proofs is not a list");
    }
    proofs.forEach((p, i) => requireRecord(method, p, `proof ${show(i)}`));
    return proofs as PathProof[];
}

/** Verifies every proof against `root` and returns the proven leaves in order. */
export function verifyProofs(method: string, root: Hex, list: PathProof[]): ProvenLeaf[] {
    const proofs = requireProofs(method, list);
    const rootHash = parseHash(method, "state root", root);
    return proofs.map((p, i) => {
        const where = `proof ${show(i)} (${show(p.path)})`;
        try {
            const path = parseHash(method, where, p.path);
            const proof = fromHex(p.proof);
            if (p.present) {
                const value = fromHex(p.value ?? "");
                if (!state.verifyProofByPath(rootHash, path, value, proof)) {
                    throw new GatewayVerificationError(method, "inclusion proof", `${where} does not verify`);
                }
                return { path: p.path, value };
            }
            if (!state.verifyAbsenceByPath(rootHash, path, proof)) {
                throw new GatewayVerificationError(method, "absence proof", `${where} does not verify`);
            }
            return { path: p.path, value: null };
        } catch (error) {
            if (error instanceof GatewayVerificationError) throw error;
            throw new GatewayVerificationError(method, "proof structure", `${where}: ${bounded((error as Error).message)}`);
        }
    });
}

function parseHash(method: string, what: string, hex: string): Hash {
    try {
        return Hash.parse(hex);
    } catch {
        throw new GatewayVerificationError(method, "hash format", `${what} is not 32 bytes of hex`);
    }
}

/** Remembers the Settlement entry of each batch. A batch entry never changes once accepted, but its `isFinalized` flag can, so it is read again until it is true. */
export class BatchRootCache {
    private readonly entries = new Map<string, SettlementBatchEntry>();

    constructor(private readonly source: BatchSource) {}

    async entry(method: string, domainId: number, batchId: number): Promise<SettlementBatchEntry> {
        const key = `${domainId}:${batchId}`;
        const cached = this.entries.get(key);
        if (cached?.isFinalized) return cached;
        const entry = await this.source(domainId, batchId);
        if (!entry) {
            throw new GatewayVerificationError(method, "batch root", `Settlement has no batch ${show(batchId)} for domain ${show(domainId)}`);
        }
        this.entries.set(key, entry);
        return entry;
    }
}

const same = (a: Hash, hex: unknown) => typeof hex === "string" && toHex(a.getBytes()) === hex.toLowerCase();

/**
 * Checks a state root against the Settlement batch entry. Skips a
 * result the gateway did not mark verified, such as one read at
 * `pending`, and reports that as unchecked.
 */
export async function checkRoot(
    method: string,
    cache: BatchRootCache | null,
    result: { domainId: number; batchId: number; verified: boolean; postStateRoot: Hex },
    tag: Tag | undefined
): Promise<boolean> {
    if (!cache || !result.verified) return false;
    const entry = await cache.entry(method, result.domainId, result.batchId);
    if (!same(entry.postStateRoot, result.postStateRoot)) {
        throw new GatewayVerificationError(method, "batch root", `postStateRoot differs from Settlement's for batch ${show(result.batchId)}`);
    }
    if (tag === "finalized" && !entry.isFinalized) {
        throw new GatewayVerificationError(method, "finality", `Settlement does not report batch ${show(result.batchId)} as finalized`);
    }
    return true;
}

/** Checks every commitment field of a `getBatch` result against Settlement's entry. */
export async function checkBatch(method: string, cache: BatchRootCache | null, batch: Batch, tag: Tag | undefined): Promise<boolean> {
    if (!cache || !batch.verified) return false;
    const entry = await cache.entry(method, batch.domainId, batch.batchId);
    const fields = ["preStateRoot", "postStateRoot", "inputRoot", "receiptRoot", "eventRoot", "outboxRoot", "daHash"] as const;
    for (const field of fields) {
        if (!same(entry[field], batch[field])) {
            throw new GatewayVerificationError(method, "batch commitment", `${field} differs from Settlement's for batch ${show(batch.batchId)}`);
        }
    }
    if (tag === "finalized" && !entry.isFinalized) {
        throw new GatewayVerificationError(method, "finality", `Settlement does not report batch ${show(batch.batchId)} as finalized`);
    }
    return true;
}

const RECEIPT_METHOD = "zeno_getReceipt";
const STRUCTURE = "receipt structure";

const failure = (check: string, detail: string) => new GatewayVerificationError(RECEIPT_METHOD, check, detail);

/** Lower-case hex of whole bytes, `length` bytes when given, as bytes. */
function hexField(what: string, value: unknown, length?: number): Uint8Array {
    if (typeof value !== "string" || !/^(?:[0-9a-f]{2})*$/.test(value)) {
        throw failure(STRUCTURE, `${what} is not lower-case hex`);
    }
    if (length !== undefined && value.length !== 2 * length) {
        throw failure(STRUCTURE, `${what} is not ${show(length)} bytes of lower-case hex`);
    }
    return fromHex(value);
}

/** A non-negative safe integer. */
function intField(what: string, value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw failure(STRUCTURE, `${what} is not a non-negative integer`);
    }
    return value;
}

/** Runs a parse of gateway data, rethrowing any error but a GatewayVerificationError as check `receipt structure`. */
function structure<T>(what: string, parse: () => T): T {
    try {
        return parse();
    } catch (error) {
        if (error instanceof GatewayVerificationError) throw error;
        throw failure(STRUCTURE, `${what}: ${bounded((error as Error).message)}`);
    }
}

/** Fails as check `receipt structure` unless `value` is an object whose keys are exactly `keys`. */
function exactKeys(what: string, value: unknown, keys: readonly string[]): void {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw failure(STRUCTURE, `${what} is not an object`);
    }
    const extra = Object.keys(value).find((key) => !keys.includes(key));
    if (extra !== undefined) throw failure(STRUCTURE, `${what} has unexpected key ${show(extra)}`);
    const missing = keys.find((key) => !(key in value));
    if (missing !== undefined) throw failure(STRUCTURE, `${what} lacks ${missing}`);
}

const EVENT_KEYS = ["contractId", "inputIndex", "eventIndex", "topics", "data"] as const;
const OUTBOX_KEYS = [
    "outboxId", "sourceContract", "inputIndex", "outboxIndex", "kind", "targetContract", "recipient", "assetId", "amount", "payload",
] as const;
const RESULT_KEYS = [
    "domainId", "batchId", "verified", "tag", "globalInputIndex", "sendHash", "sender", "receipt", "returnData", "events", "outbox", "input",
] as const;

/** The first key, over both objects' keys, whose values are not `===`. */
function firstDifference(got: object, want: Record<string, unknown>): string | undefined {
    const have = got as Record<string, unknown>;
    return [...Object.keys(got), ...Object.keys(want)].find((key) => have[key] !== want[key]);
}

/** The SPEC §27.3 event encoding of one gateway event. */
function encodeEvent(e: EventJson, i: number): Uint8Array {
    const what = `event ${i}`;
    exactKeys(what, e, EVENT_KEYS);
    if (!Array.isArray(e.topics)) throw failure(STRUCTURE, `${what} topics is not a list`);
    return new ZenoWriter()
        .bytes32(hexField(`${what} contractId`, e.contractId, 32))
        .u64(intField(`${what} inputIndex`, e.inputIndex))
        .u32(intField(`${what} eventIndex`, e.eventIndex))
        .list(e.topics, (w, t) => w.bytes32(hexField(`${what} topic`, t, 32)))
        .bytes(hexField(`${what} data`, e.data))
        .finish();
}

/** The SPEC §27.4 OutboxMessage encoding of one gateway outbox item. */
function encodeOutboxItem(o: OutboxJson, i: number): Uint8Array {
    const what = `outbox item ${i}`;
    exactKeys(what, o, OUTBOX_KEYS);
    const w = new ZenoWriter()
        .bytes32(hexField(`${what} sourceContract`, o.sourceContract, 32))
        .u64(intField(`${what} inputIndex`, o.inputIndex))
        .u32(intField(`${what} outboxIndex`, o.outboxIndex));
    const absent = (...fields: (keyof OutboxJson)[]) => {
        for (const field of fields) {
            if (o[field] !== null) throw failure("outbox root", `${what} carries ${field}`);
        }
    };
    const present = (...fields: (keyof OutboxJson)[]) => {
        for (const field of fields) {
            if (o[field] === null) throw failure("outbox root", `${what} lacks ${field}`);
        }
    };
    if (o.kind === "L2_DELIVERY") {
        absent("recipient", "assetId", "amount");
        present("targetContract");
        w.u8(OutboxKind.L2_DELIVERY).bytes32(hexField(`${what} targetContract`, o.targetContract, 32));
    } else if (o.kind === "L1_WITHDRAWAL") {
        absent("targetContract");
        present("recipient", "assetId", "amount");
        const recipient = o.recipient as string;
        const amount = o.amount;
        let address: Address | undefined;
        try {
            address = Address.parse(recipient);
        } catch {
            // not a z address: the check below refuses it
        }
        if (address === undefined || address.toString() !== recipient) {
            throw failure(STRUCTURE, `${what} recipient is not a canonical address`);
        }
        if (typeof amount !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(amount)) throw failure(STRUCTURE, `${what} amount is not a decimal integer`);
        w.u8(OutboxKind.L1_WITHDRAWAL)
            .address(address.getBytes())
            .bytes32(hexField(`${what} assetId`, o.assetId, 32))
            .u256(BigInt(amount));
    } else {
        throw failure("outbox root", `${what} has unknown kind ${show(o.kind)}`);
    }
    return w.bytes(hexField(`${what} payload`, o.payload)).finish();
}

/** The reader's JSON form of a canonical input. */
function inputJson(data: Uint8Array): Record<string, unknown> {
    const r = new ZenoReader(data);
    const kind = r.u8();
    const hash = () => toHex(r.bytes32());
    const head = { inputKind: kind, sourceAccountBlockHash: hash() };
    let json: Record<string, unknown>;
    switch (kind) {
        case InputKind.CALL_L2:
            json = {
                kind: "CallL2", ...head, targetContract: hash(), plasmaLimit: Number(r.u64()),
                depositAsset: hash(), depositAmount: r.u256().toString(), payload: toHex(r.bytes()),
            };
            break;
        case InputKind.DEPOSIT:
            json = {
                kind: "Deposit", ...head, targetContract: hash(), plasmaLimit: Number(r.u64()),
                depositAsset: hash(), depositAmount: r.u256().toString(),
            };
            break;
        case InputKind.DEPLOY_CONTRACT_START:
            json = {
                kind: "DeployContractStart", ...head, codeHash: hash(), metadataHash: hash(),
                totalSize: Number(r.u64()), chunkCount: r.u32(), metadata: toHex(r.bytes()),
            };
            break;
        case InputKind.DEPLOY_CONTRACT_CHUNK:
            json = { kind: "DeployContractChunk", ...head, codeHash: hash(), chunkIndex: r.u32(), chunkHash: hash() };
            break;
        case InputKind.DEPLOY_CONTRACT_FINALIZE:
            json = { kind: "DeployContractFinalize", ...head, codeHash: hash() };
            break;
        case InputKind.UPGRADE_CONTRACT:
            json = { kind: "UpgradeContract", ...head, contractId: hash(), newCodeHash: hash() };
            break;
        case InputKind.TRANSFER_CONTRACT_OWNERSHIP:
            json = {
                kind: "TransferContractOwnership", ...head, contractId: hash(),
                newOwner: Address.fromCore(Buffer.from(r.address())).toString(),
            };
            break;
        default:
            json = { kind: "BuyStorage", ...head, contractId: hash(), bytes: Number(r.u64()) };
    }
    r.end();
    return json;
}

/** The domain send `S` calls and the canonical input zeno-executor builds from it. Throws check `send block` for a block that is not an input send to Settlement. */
function inputOfSend(S: Hex, block: SendBlock): { domainId: number; input: CanonicalInput } {
    if (block.blockType !== BlockTypeEnum.UserSend || block.toAddress.toString() !== SETTLEMENT_ADDRESS.toString()) {
        throw failure("send block", `${show(S)} is not a send to Settlement`);
    }
    try {
        const { name, args } = SettlementContract.decodeCallData("0x" + toHex(block.data));
        const a = args as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        const hash = (x: string) => Hash.parse(x.slice(2));
        const deposit = () => {
            const amount = BigInt(block.amount);
            return amount === 0n
                ? { depositAsset: new Hash(Buffer.alloc(32)), depositAmount: 0n }
                : { depositAsset: settlement.assetIdFromZts(block.tokenStandard), depositAmount: amount };
        };
        let input: CanonicalInput;
        switch (name) {
            case "CallL2":
                input = {
                    kind: InputKind.CALL_L2, targetContract: hash(a.targetContract), plasmaLimit: a.plasmaLimit,
                    payload: fromHex(a.payload.slice(2)), ...deposit(),
                };
                break;
            case "Deposit":
                input = { kind: InputKind.DEPOSIT, targetContract: hash(a.targetContract), plasmaLimit: a.plasmaLimit, ...deposit() };
                break;
            case "DeployContractStart":
                input = {
                    kind: InputKind.DEPLOY_CONTRACT_START, codeHash: hash(a.codeHash), metadataHash: hash(a.metadataHash),
                    totalSize: a.totalSize, chunkCount: a.chunkCount, metadata: fromHex(a.metadata.slice(2)),
                };
                break;
            case "DeployContractChunk":
                input = { kind: InputKind.DEPLOY_CONTRACT_CHUNK, codeHash: hash(a.codeHash), chunkIndex: a.chunkIndex, chunkHash: hash(a.chunkHash) };
                break;
            case "DeployContractFinalize":
                input = { kind: InputKind.DEPLOY_CONTRACT_FINALIZE, codeHash: hash(a.codeHash) };
                break;
            case "UpgradeContract":
                input = { kind: InputKind.UPGRADE_CONTRACT, contractId: hash(a.contractId), newCodeHash: hash(a.newCodeHash) };
                break;
            case "TransferContractOwnership":
                input = { kind: InputKind.TRANSFER_CONTRACT_OWNERSHIP, contractId: hash(a.contractId), newOwner: Address.parse(a.newOwner) };
                break;
            case "BuyStorage":
                input = { kind: InputKind.BUY_STORAGE, contractId: hash(a.contractId), bytes: a.bytes };
                break;
            default:
                throw failure("send block", `send ${show(S)} calls Settlement's ${show(name)}, not an input method`);
        }
        return { domainId: a.domainId, input };
    } catch (error) {
        if (error instanceof GatewayVerificationError) throw error;
        throw failure("send block", `send ${show(S)}'s call data does not decode: ${bounded((error as Error).message)}`);
    }
}

/** The check behind GatewayClient.verifyReceipt. */
export async function checkReceipt(
    reads: Pick<GatewayClient, "getReceiptSidecar">,
    roots: BatchRootCache | null,
    sends: SendSource | null,
    sendHash: Hex,
    r: ReceiptResult
): Promise<boolean> {
    if (typeof sendHash !== "string" || !/^[0-9a-fA-F]{64}$/.test(sendHash)) {
        throw new RangeError("sendHash is not 32 bytes of hex");
    }
    const S = sendHash.toLowerCase();
    if (typeof r !== "object" || r === null) throw failure(STRUCTURE, "the receipt result is not an object");
    const tag: string = r.tag;
    if (tag !== "pending" && tag !== "latest" && tag !== "finalized") {
        throw failure(STRUCTURE, `tag ${show(tag)} is not pending, latest or finalized`);
    }
    if (r.sendHash !== S) throw failure("send binding", `the receipt is for send ${show(r.sendHash)}, not ${show(S)}`);
    if (sends === null) throw new Error("verifyReceipt needs a send source");
    const D = intField("domainId", r.domainId);
    const block = await sends(Hash.parse(S));
    if (block === null) throw new Error(`the node has no account block ${show(S)} yet`);
    const { domainId, input } = inputOfSend(S, block);
    if (domainId !== D) throw failure("domain binding", `send ${show(S)} calls domain ${show(domainId)}, not the receipt's ${show(D)}`);
    if (!("sender" in r)) throw failure(STRUCTURE, "the receipt result lacks sender");
    if (typeof r.sender !== "string") throw failure(STRUCTURE, "sender is not a string");
    if (block.address.toString() !== r.sender) {
        throw failure("sender binding", `send ${show(S)} comes from ${show(block.address.toString())}, not the receipt's sender ${show(r.sender)}`);
    }
    if (tag === "pending") return false;
    exactKeys("the receipt result", r, RESULT_KEYS);
    if (!Array.isArray(r.events)) throw failure(STRUCTURE, "events is not a list");
    if (!Array.isArray(r.outbox)) throw failure(STRUCTURE, "outbox is not a list");
    if (roots === null) throw new Error("verifyReceipt needs a batch source");

    const N = intField("batchId", r.batchId);
    const I = intField("globalInputIndex", r.globalInputIndex);
    const entry = await roots.entry(RECEIPT_METHOD, D, N);
    if (tag === "finalized" && !entry.isFinalized) {
        throw failure("finality", `Settlement does not report batch ${show(N)} as finalized`);
    }

    const daHash = toHex(entry.daHash.getBytes());
    const sidecarResult = await reads.getReceiptSidecar(daHash);
    const leaves = structure("sidecar", () => {
        const reader = new ZenoReader(hexField("sidecar", sidecarResult.sidecar));
        const list = reader.list((x) => x.bytes());
        reader.end();
        return list;
    });
    if (toHex(merkleRoot(leaves).getBytes()) !== toHex(entry.receiptRoot.getBytes())) {
        throw failure("receipt root", `the sidecar does not hash to the receiptRoot Settlement recorded for batch ${show(N)}`);
    }

    const own = structure("sidecar", () => leaves.map(decodeReceipt)).filter((l) => l.inputIndex === BigInt(I));
    if (own.length !== 1) throw failure("receipt leaf", `batch ${show(N)}'s sidecar holds ${show(own.length)} receipts for input ${show(I)}`);
    const leaf = own[0];
    if (leaf.batchId !== BigInt(N)) throw failure("receipt leaf", `the leaf names batch ${show(leaf.batchId)}, not ${show(N)}`);

    const statusName = Object.entries(ReceiptStatus).find(([, value]) => value === leaf.status)?.[0];
    if (statusName === undefined) throw failure("receipt leaf", `the leaf's status ${show(leaf.status)} has no name`);
    const h = (x: Hash) => toHex(x.getBytes());
    const wantReceipt: Record<string, unknown> = {
        inputIndex: Number(leaf.inputIndex),
        inputHash: h(leaf.inputHash),
        batchId: Number(leaf.batchId),
        contractId: h(leaf.contractId),
        codeHash: h(leaf.codeHash),
        status: statusName,
        gasUsed: Number(leaf.gasUsed),
        abortCode: leaf.abortCode,
        stateDiffHash: h(leaf.stateDiffHash),
        returnHash: h(leaf.returnHash),
        eventRoot: h(leaf.eventRoot),
        eventCount: leaf.eventCount,
        outboxRoot: h(leaf.outboxRoot),
        outboxCount: leaf.outboxCount,
    };
    const receiptKey = structure("receipt", () => firstDifference(r.receipt, wantReceipt));
    if (receiptKey !== undefined) throw failure("receipt leaf", `${show(receiptKey)} differs from the leaf Settlement committed`);

    const encoding = encodeInput(Hash.parse(S), input);
    if (toHex(sha3(encoding)) !== h(leaf.inputHash)) {
        throw failure("input hash", `the input of send ${show(S)} does not hash to the leaf's inputHash`);
    }

    if (r.input !== null) {
        const input = r.input;
        structure("input", () => {
            const inputKey = firstDifference(input, inputJson(encoding));
            if (inputKey !== undefined) throw failure("input", `${show(inputKey)} differs from input ${show(I)}'s data`);
        });
    }

    const data = hexField("returnData", r.returnData);
    const wantReturn = data.length === 0 ? new Uint8Array(32) : sha3(data);
    if (toHex(wantReturn) !== h(leaf.returnHash)) {
        throw failure("return hash", "the return data does not hash to the leaf's returnHash");
    }

    if (structure("events", () => toHex(merkleRoot(r.events.map(encodeEvent)).getBytes())) !== h(leaf.eventRoot)) {
        throw failure("event root", "the events do not hash to the leaf's eventRoot");
    }
    if (structure("outbox", () => toHex(merkleRoot(r.outbox.map(encodeOutboxItem)).getBytes())) !== h(leaf.outboxRoot)) {
        throw failure("outbox root", "the outbox items do not hash to the leaf's outboxRoot");
    }
    r.outbox.forEach((o, i) => {
        const want = settlement.outboxId(D, BigInt(N), BigInt(o.inputIndex), o.outboxIndex).toString();
        if (o.outboxId !== want) throw failure("outbox id", `outbox item ${show(i)} has id ${show(o.outboxId)}, want ${show(want)}`);
    });
    return true;
}

export type ReadView = ReadResult;
