import { Address, Hash, settlement } from "znn-typescript-sdk";
import { ZenoCodecError, ZenoReader } from "./codec.js";
import { show } from "./format.js";
import {
    InputKind,
    MaxEventDataSize,
    MaxEventsPerExecution,
    MaxExecutionResult,
    MaxOutboxPayloadSize,
    MaxOutboxPerExecution,
    MaxReturnData,
    MaxStateValueSize,
    MaxTopicsPerEvent,
} from "./constants.js";
const { ztsFromAssetId } = settlement;

const hash = (bytes: Uint8Array) => new Hash(Buffer.from(bytes));

const EMPTY_LENGTH = 0xffffffff;
const EXECUTION_RESULT_VERSION = 1;

export interface Receipt {
    receiptVersion: number;
    inputIndex: bigint;
    inputHash: Hash;
    batchId: bigint;
    contractId: Hash;
    codeHash: Hash;
    status: number;
    gasUsed: bigint;
    abortCode: number;
    stateDiffHash: Hash;
    returnHash: Hash;
    eventRoot: Hash;
    eventCount: number;
    outboxRoot: Hash;
    outboxCount: number;
}

/** SPEC §27.7. */
export function decodeReceipt(data: Uint8Array): Receipt {
    const r = new ZenoReader(data);
    const receipt: Receipt = {
        receiptVersion: r.u16(),
        inputIndex: r.u64(),
        inputHash: hash(r.bytes32()),
        batchId: r.u64(),
        contractId: hash(r.bytes32()),
        codeHash: hash(r.bytes32()),
        status: r.u8(),
        gasUsed: r.u64(),
        abortCode: r.i32(),
        stateDiffHash: hash(r.bytes32()),
        returnHash: hash(r.bytes32()),
        eventRoot: hash(r.bytes32()),
        eventCount: r.u32(),
        outboxRoot: hash(r.bytes32()),
        outboxCount: r.u32(),
    };
    r.end();
    return receipt;
}

export interface StateDiffEntry {
    key: Hash;
    /** `null` is the `EMPTY` deletion sentinel. */
    value: Uint8Array | null;
}

export interface ZenoEvent {
    contractId: Hash;
    inputIndex: bigint;
    eventIndex: number;
    topics: Hash[];
    data: Uint8Array;
}

export const OutboxKind = { L2_DELIVERY: 0, L1_WITHDRAWAL: 1 } as const;

export type OutboxMessage =
    | {
          kind: typeof OutboxKind.L2_DELIVERY;
          sourceContract: Hash;
          inputIndex: bigint;
          outboxIndex: number;
          targetContract: Hash;
          payload: Uint8Array;
      }
    | {
          kind: typeof OutboxKind.L1_WITHDRAWAL;
          sourceContract: Hash;
          inputIndex: bigint;
          outboxIndex: number;
          recipient: Address;
          assetId: Hash;
          amount: bigint;
          payload: Uint8Array;
      };

function readOutboxMessage(r: ZenoReader): OutboxMessage {
    const sourceContract = hash(r.bytes32());
    const inputIndex = r.u64();
    const outboxIndex = r.u32();
    const kind = r.u8();

    if (kind === OutboxKind.L2_DELIVERY) {
        const targetContract = hash(r.bytes32());
        const payload = r.bytes(MaxOutboxPayloadSize);
        return { kind, sourceContract, inputIndex, outboxIndex, targetContract, payload };
    }
    if (kind === OutboxKind.L1_WITHDRAWAL) {
        const recipient = Address.fromCore(r.address());
        const assetId = hash(r.bytes32());
        try {
            ztsFromAssetId(assetId);
        } catch {
            throw new ZenoCodecError("non-canonical AssetID");
        }
        const amount = r.u256();
        const payload = r.bytes(MaxOutboxPayloadSize);
        if (payload.length !== 0) {
            throw new ZenoCodecError("an L1 withdrawal must carry an empty payload");
        }
        return { kind, sourceContract, inputIndex, outboxIndex, recipient, assetId, amount, payload };
    }
    throw new ZenoCodecError(`invalid outbox kind ${show(kind)}`);
}

/** SPEC §27.4. */
export function decodeOutboxMessage(data: Uint8Array): OutboxMessage {
    const r = new ZenoReader(data);
    const message = readOutboxMessage(r);
    r.end();
    return message;
}

function readStateDiffEntry(r: ZenoReader): StateDiffEntry {
    const key = hash(r.bytes32());
    const length = r.u32();
    if (length === EMPTY_LENGTH) {
        return { key, value: null };
    }
    if (length > MaxStateValueSize) {
        throw new ZenoCodecError(`state value length ${show(length)} exceeds ${show(MaxStateValueSize)}`);
    }
    return { key, value: r.fixed(length) };
}

function readEvent(r: ZenoReader): ZenoEvent {
    return {
        contractId: hash(r.bytes32()),
        inputIndex: r.u64(),
        eventIndex: r.u32(),
        topics: r.list((x) => hash(x.bytes32()), MaxTopicsPerEvent),
        data: r.bytes(MaxEventDataSize),
    };
}

export interface ExecutionResult {
    executionResultVersion: number;
    globalInputIndex: bigint;
    preStateRoot: Hash;
    postStateRoot: Hash;
    stateDiff: StateDiffEntry[];
    events: ZenoEvent[];
    outbox: OutboxMessage[];
    returnData: Uint8Array;
    claimedDeposit: bigint;
}

/**
 * SPEC §27.1a. Rejects trailing bytes, an unknown version, an unsorted
 * or duplicated `StateDiff`, an event or outbox index that is not its
 * position, an inputIndex that is not the globalInputIndex, and
 * out-of-bounds lists.
 */
export function decodeExecutionResult(data: Uint8Array): ExecutionResult {
    if (data.length > MaxExecutionResult) {
        throw new ZenoCodecError(`ExecutionResult exceeds ${show(MaxExecutionResult)} bytes`);
    }
    const r = new ZenoReader(data);
    const executionResultVersion = r.u16();
    if (executionResultVersion !== EXECUTION_RESULT_VERSION) {
        throw new ZenoCodecError(`unknown ExecutionResult version ${show(executionResultVersion)}`);
    }
    const globalInputIndex = r.u64();
    const preStateRoot = hash(r.bytes32());
    const postStateRoot = hash(r.bytes32());
    const stateDiff = r.list(readStateDiffEntry);
    const events = r.list(readEvent, MaxEventsPerExecution);
    const outbox = r.list(readOutboxMessage, MaxOutboxPerExecution + 1);
    const returnData = r.bytes(MaxReturnData);
    const claimedDeposit = r.u256();
    r.end();

    for (let i = 1; i < stateDiff.length; i++) {
        if (Buffer.compare(stateDiff[i - 1].key.getBytes(), stateDiff[i].key.getBytes()) >= 0) {
            throw new ZenoCodecError("StateDiff keys must be strictly ascending");
        }
    }

    events.forEach((e, i) => {
        if (e.eventIndex !== i) {
            throw new ZenoCodecError(`event ${show(i)} has eventIndex ${show(e.eventIndex)}`);
        }
        if (e.inputIndex !== globalInputIndex) {
            throw new ZenoCodecError(`event ${show(i)} has inputIndex ${show(e.inputIndex)}, not the globalInputIndex ${show(globalInputIndex)}`);
        }
    });
    outbox.forEach((m, i) => {
        if (m.outboxIndex !== i) {
            throw new ZenoCodecError(`outbox message ${show(i)} has outboxIndex ${show(m.outboxIndex)}`);
        }
        if (m.inputIndex !== globalInputIndex) {
            throw new ZenoCodecError(`outbox message ${show(i)} has inputIndex ${show(m.inputIndex)}, not the globalInputIndex ${show(globalInputIndex)}`);
        }
    });

    return {
        executionResultVersion,
        globalInputIndex,
        preStateRoot,
        postStateRoot,
        stateDiff,
        events,
        outbox,
        returnData,
        claimedDeposit,
    };
}

/** One SMT witness of a bundle record. A null `value` is the EMPTY sentinel: the key is absent. */
export interface WitnessEntry extends StateDiffEntry {
    proof: Uint8Array;
}

/** One input's record in a DA bundle (SPEC §20). */
export interface BundleRecord {
    globalInputIndex: bigint;
    inputData: Uint8Array;
    witnesses: WitnessEntry[];
    executionResult: Uint8Array;
    /** The chunk bytes of a kind-3 record, null for every other kind. */
    deployChunkData: Uint8Array | null;
}

/**
 * SPEC §20. Rejects records not strictly ascending by globalInputIndex
 * and witnesses not strictly ascending by key. Leaves each
 * executionResult encoded.
 */
export function decodeBundle(data: Uint8Array): BundleRecord[] {
    const r = new ZenoReader(data);
    const records: BundleRecord[] = [];
    while (r.remaining > 0) {
        const globalInputIndex = r.u64();
        const inputData = r.bytes();
        const witnesses = r.list((x) => ({ ...readStateDiffEntry(x), proof: x.bytes() }));
        for (let i = 1; i < witnesses.length; i++) {
            if (Buffer.compare(witnesses[i - 1].key.getBytes(), witnesses[i].key.getBytes()) >= 0) {
                throw new ZenoCodecError("bundle witness keys must be strictly ascending");
            }
        }
        const executionResult = r.bytes();
        const deployChunkData = inputData[0] === InputKind.DEPLOY_CONTRACT_CHUNK ? r.bytes() : null;
        if (records.length > 0 && globalInputIndex <= records[records.length - 1].globalInputIndex) {
            throw new ZenoCodecError("bundle records must be strictly ascending by globalInputIndex");
        }
        records.push({ globalInputIndex, inputData, witnesses, executionResult, deployChunkData });
    }
    return records;
}

export interface DeployReturnData {
    codeHash: Hash;
    /** The post-instrumentation `CodeHash`. */
    executableCodeHash: Hash;
}

/** `ReturnData` of a successful `DeployContractFinalize`: `code_hash || CodeHash`. */
export function decodeDeployReturnData(data: Uint8Array): DeployReturnData {
    const r = new ZenoReader(data);
    const codeHash = hash(r.bytes32());
    const executableCodeHash = hash(r.bytes32());
    r.end();
    return { codeHash, executableCodeHash };
}

export interface UpgradeReturnData {
    oldCodeHash: Hash;
    newCodeHash: Hash;
}

/** `ReturnData` of a successful `UpgradeContract`: `oldCodeHash || newCodeHash`. */
export function decodeUpgradeReturnData(data: Uint8Array): UpgradeReturnData {
    const r = new ZenoReader(data);
    const oldCodeHash = hash(r.bytes32());
    const newCodeHash = hash(r.bytes32());
    r.end();
    return { oldCodeHash, newCodeHash };
}

export interface RevertData {
    abortCode: number;
    /** Raw revert data; the contract's interface decodes its fields. */
    data: Uint8Array;
}

/** The revert data of a `REVERT` receipt is the receipt's `ReturnData` (SPEC §15). */
export function decodeRevertData(abortCode: number, returnData: Uint8Array): RevertData {
    if (returnData.length > MaxReturnData) {
        throw new ZenoCodecError(`revert data exceeds ${show(MaxReturnData)} bytes`);
    }
    return { abortCode, data: Uint8Array.from(returnData) };
}

