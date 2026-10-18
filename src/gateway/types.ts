/** Lowercase hex without a prefix, as the gateway writes bytes and hashes. */
export type Hex = string;

export type TagName = "pending" | "latest" | "finalized";
/** A tag name, or a batch id. */
export type Tag = TagName | bigint | number;

export type DomainStatus = "SYNCING" | "OK" | "INCONSISTENT";

export interface TagHead {
    batchId: number;
    lastInputSeq: number;
    postStateRoot: Hex;
    verified: boolean;
}

export interface Head {
    domainId: number;
    status: DomainStatus;
    inconsistentAt: number | null;
    pending: TagHead | null;
    latest: TagHead | null;
    finalized: TagHead | null;
}

export interface ProfileInfo {
    name: string;
    features: Record<string, boolean>;
    interfaceEncodings: string[];
}

export interface ViewParam {
    name: string;
    type: string;
    optional: boolean;
    maxLength?: number;
}

export interface ViewInfo {
    name: string;
    profile?: string;
    params: ViewParam[];
    result: string[];
}

export interface ChainInfo {
    domainId: number;
    networkName: string;
    chain_id: Hex | null;
    runtimeKind: string | null;
    stfSpecHash: Hex | null;
    status: DomainStatus;
    inconsistentAt: number | null;
    profiles: ProfileInfo[];
    views: ViewInfo[];
}

export interface BatchInput {
    globalInputIndex: number;
    sendHash: Hex;
    status: string;
}

export interface Batch {
    domainId: number;
    batchId: number;
    verified: boolean;
    firstInputSeq: number;
    lastInputSeq: number;
    preStateRoot: Hex;
    postStateRoot: Hex;
    inputRoot: Hex;
    receiptRoot: Hex;
    eventRoot: Hex;
    outboxRoot: Hex;
    daHash: Hex;
    inputs: BatchInput[];
}

export interface ReceiptJson {
    inputIndex: number;
    inputHash: Hex;
    batchId: number;
    contractId: Hex;
    codeHash: Hex;
    status: string;
    gasUsed: number;
    abortCode: number;
    stateDiffHash: Hex;
    returnHash: Hex;
    eventRoot: Hex;
    eventCount: number;
    outboxRoot: Hex;
    outboxCount: number;
}

export interface EventJson {
    contractId: Hex;
    inputIndex: number;
    eventIndex: number;
    topics: Hex[];
    data: Hex;
}

export interface OutboxJson {
    outboxId: Hex;
    sourceContract: Hex;
    inputIndex: number;
    outboxIndex: number;
    kind: string;
    targetContract: Hex | null;
    recipient: string | null;
    assetId: Hex | null;
    amount: string | null;
    payload: Hex;
}

/** The domain's decoded input, or null when the domain has no reader. */
export type DecodedInput = ({ kind: string; inputKind: number; sourceAccountBlockHash: Hex } & Record<string, unknown>) | null;

export interface ReceiptResult {
    domainId: number;
    batchId: number;
    verified: boolean;
    tag: TagName;
    globalInputIndex: number;
    sendHash: Hex;
    sender: string;
    receipt: ReceiptJson;
    returnData: Hex;
    events: EventJson[];
    outbox: OutboxJson[];
    input: DecodedInput;
}

export interface PathProof {
    path: Hex;
    present: boolean;
    value: Hex | null;
    proof: Hex;
}

export interface StateResult {
    domainId: number;
    batchId: number;
    verified: boolean;
    postStateRoot: Hex;
    path: Hex;
    present: boolean;
    value: Hex | null;
}

export interface ProofResult {
    domainId: number;
    batchId: number;
    verified: boolean;
    postStateRoot: Hex;
    proofs: PathProof[];
}

export interface ReadResult<T = unknown> {
    domainId: number;
    batchId: number;
    verified: boolean;
    postStateRoot: Hex;
    view: string;
    result: T;
    proofs: PathProof[];
}

export interface InputItem {
    globalInputIndex: number;
    batchId: number;
    verified: boolean;
    sendHash: Hex;
    sender: string;
    inputKind: number;
    receipt: { status: string; contractId: Hex; gasUsed: number; abortCode: number };
    input: DecodedInput;
}

export type EventItem = EventJson & { batchId: number; verified: boolean };
export type OutboxItem = OutboxJson & { batchId: number; verified: boolean };

export interface Page<T> {
    domainId: number;
    batchId: number | null;
    verified: boolean;
    items: T[];
    nextCursor: string | null;
}

/** Filter members shared by every list method. */
export interface ListFilter {
    domainId: number;
    fromBatch?: number | bigint;
    toBatch?: Tag;
    limit?: number;
    cursor?: string | null;
}

export interface InputFilter extends ListFilter {
    contractId?: Hex;
    sender?: string;
    inputKind?: number;
}

export interface EventFilter extends ListFilter {
    contractId?: Hex;
    /** Up to four entries matched by position. A null entry matches any topic. */
    topics?: (Hex | null)[];
}

export interface OutboxFilter extends ListFilter {
    recipient?: string;
}

export interface OutboxProofResult {
    domainId: number;
    batchId: number;
    verified: boolean;
    tag: TagName;
    outboxId: Hex;
    outboxRoot: Hex;
    message: Hex;
    inclusionProof: Hex;
    decoded: OutboxJson;
    processedOutbox: boolean;
}

export interface BundleResult {
    domainId: number;
    batchId: number;
    verified: boolean;
    daHash: Hex;
    bundle: Hex;
}

export interface SidecarResult {
    domainId: number;
    batchId: number;
    verified: boolean;
    daHash: Hex;
    sidecar: Hex;
}

export interface SimulateInput {
    kind: "CallL2" | "Deposit";
    sender: string;
    targetContract: Hex;
    /** Hex, CallL2 only. */
    payload?: Hex;
    deposit?: { asset: Hex; amount: string };
    plasmaLimit: number | bigint;
}

export interface StateDiffJson {
    path: Hex;
    /** Null deletes. An empty string is present-empty. */
    value: Hex | null;
}

export interface SimulateResult {
    domainId: number;
    batchId: number;
    postStateRoot: Hex;
    verified: false;
    simulated: true;
    inputIndex: number;
    momentumHeight: number;
    momentumTime: number;
    momentumHash: Hex;
    status: string;
    gasUsed: number;
    abortCode: number;
    contractId: Hex;
    codeHash: Hex;
    returnData: Hex;
    events: EventJson[];
    outbox: (Omit<OutboxJson, "outboxId"> & { outboxId: null })[];
    stateDiff: StateDiffJson[];
}

export type HeadsNotification = Head;

export interface ReceiptNotification {
    domainId: number;
    batchId: number;
    daHash: Hex;
    sendHash: Hex;
    tag: TagName;
    verified: boolean;
    removed: boolean;
}

export interface EventsNotification {
    domainId: number;
    batchId: number;
    daHash: Hex;
    verified: boolean;
    removed: boolean;
    count: number;
}

export interface SubscriptionKinds {
    heads: { params: [domainId: number]; result: HeadsNotification };
    receipt: { params: [sendHash: Hex]; result: ReceiptNotification };
    events: { params: [filter: { domainId: number; contractId?: Hex; topics?: (Hex | null)[] }, tag?: Tag]; result: EventsNotification };
}

/**
 * A state value with the SPEC 13.6 distinction kept: `{ present: false }`
 * is an absent key, and `{ present: true, value }` with an empty value is
 * present-empty.
 */
export type StateValue = { present: true; value: Uint8Array } | { present: false };
