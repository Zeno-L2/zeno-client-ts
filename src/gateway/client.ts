import type { Client } from "znn-typescript-sdk";
import { hexToBytes } from "../bytes.js";
import { ZenoCodecError } from "../codec.js";
import { show } from "../format.js";
import { pathDerivationFor } from "../runtime/registry.js";
import { ContractsProfile, contractsProfile } from "./contracts.js";
import { GatewayVerificationError, mapGatewayError } from "./errors.js";
import { DEFAULT_MAX_RESPONSE_SIZE, DEFAULT_TIMEOUT_MS, HttpClient } from "./http.js";
import { GatewaySocket } from "./ws.js";
import { BatchRootCache, checkBatch, checkReceipt, checkRoot, requireProofs, requireRecord, verifyProofs } from "./verify.js";
import type { BatchSource, SendSource, Verified, VerificationReport } from "./verify.js";
import type {
    Batch,
    BundleResult,
    ChainInfo,
    EventFilter,
    EventItem,
    Head,
    Hex,
    InputFilter,
    InputItem,
    ListFilter,
    OutboxFilter,
    OutboxItem,
    OutboxProofResult,
    Page,
    ProofResult,
    ReadResult,
    ReceiptResult,
    SidecarResult,
    SimulateInput,
    SimulateResult,
    StateResult,
    StateValue,
    SubscriptionKinds,
    Tag,
} from "./types.js";

/** Delivers the gateway's `zeno_subscription` notifications to a handler. Returns a function that stops the delivery. */
export interface NotificationSource {
    onNotification(handler: (params: { subscription: string; result: unknown }) => void): () => void;
}

export interface GatewayClientOptions {
    /**
     * Reads batch entries from Settlement. With it, results the gateway
     * marks verified are checked against the roots Settlement records.
     * Without it, proofs are still checked against the root the response
     * names, and `rootChecked` stays false.
     */
    batches?: BatchSource;
    /** Reads L1 send blocks for `verifyReceipt`, from the node `batches` reads. */
    sends?: SendSource;
    /** Required for `subscribe`. A WebSocket URL given to `connect` supplies it. */
    notifications?: NotificationSource;
    /** Called by `close`. */
    onClose?: () => void;
    /** Receives an error a subscription handler throws while `subscribe` delivers the results queued before it returned. */
    onError?: (error: Error) => void;
}

/** The most results queued across all subscription ids that no handler has claimed yet. Later notifications are dropped. */
const EARLY_NOTIFICATION_LIMIT = 16;

/**
 * Client for the gateway's `zeno_*` JSON-RPC API. One client serves every
 * domain, because the method set is the same for each. Requests over
 * `http(s)` and over a WebSocket use zeno-client-ts transports that bound
 * the size and the duration of each response.
 */
export class GatewayClient {
    private readonly handlers = new Map<string, (result: unknown) => void>();
    private readonly early = new Map<string, unknown[]>();
    private earlyCount = 0;
    private subscribing = 0;
    private stopNotifications: (() => void) | null = null;
    private readonly roots: BatchRootCache | null;
    private readonly infos = new Map<number, Promise<ChainInfo>>();

    constructor(
        private readonly rpc: Client,
        private readonly options: GatewayClientOptions = {}
    ) {
        this.roots = options.batches ? new BatchRootCache(options.batches) : null;
    }

    /**
     * Builds a client for `url`. A `ws://` or `wss://` URL opens a
     * WebSocket, which also carries subscriptions. An `http://` or
     * `https://` URL serves requests only. `maxResponseSize` is the most
     * bytes one response or WebSocket message may hold (default 64 MiB).
     * A WebSocket message over it closes the connection, which is never
     * reopened, and `onError` receives the `ResponseSizeError`. From Node
     * 22.23.0, 24.17.0 and 26.1.0, undici's default `maxPayloadSize`
     * (128 MiB) makes the runtime fail the connection first, so requests
     * and `onError` get `the gateway WebSocket failed` and a larger limit
     * has no effect on a WebSocket there. Earlier Node releases have no
     * such limit, and a browser buffers each whole message.
     * `maxResponseSize` must be a number of at least 1. `timeoutMs`
     * (default 30 s) bounds the WebSocket open and each request, and must
     * be an integer from 1 to 2,147,483,647 (`RangeError` otherwise).
     * `onError` also receives a connection close or error the caller did
     * not start, a malformed message and an error a subscription handler
     * throws.
     */
    static async connect(
        url: string,
        options: { timeoutMs?: number; batches?: BatchSource; sends?: SendSource; maxResponseSize?: number; onError?: (error: Error) => void } = {}
    ): Promise<GatewayClient> {
        const maxResponseSize = options.maxResponseSize ?? DEFAULT_MAX_RESPONSE_SIZE;
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        if (/^https?:/i.test(url)) {
            return new GatewayClient(new HttpClient(url, maxResponseSize, undefined, timeoutMs), { batches: options.batches, sends: options.sends });
        }
        if (/^wss?:/i.test(url)) {
            const socket = await GatewaySocket.open(url, maxResponseSize, timeoutMs, options.onError);
            return new GatewayClient(socket, { batches: options.batches, sends: options.sends, notifications: socket, onClose: () => socket.close(), onError: options.onError });
        }
        throw new TypeError("the gateway URL must start with http://, https://, ws:// or wss://");
    }

    /** Stops notifications and closes a WebSocket transport. */
    close(): void {
        this.stopNotifications?.();
        this.stopNotifications = null;
        this.handlers.clear();
        this.clearEarly();
        this.options.onClose?.();
    }

    private async call<T>(method: string, params: unknown[]): Promise<T> {
        try {
            return (await this.rpc.sendRequest(method, params)) as T;
        } catch (error) {
            throw mapGatewayError(error, method);
        }
    }

    async chainInfo(domainId: number): Promise<ChainInfo> {
        return requireRecord<ChainInfo>("zeno_chainInfo", await this.call("zeno_chainInfo", [domainId]));
    }

    getHead(domainId: number): Promise<Head> {
        return this.call("zeno_getHead", [domainId]);
    }

    /** The `contracts/1` helpers. Throws `UnsupportedProfileError` for a domain without the profile. */
    contracts(domainId: number): Promise<ContractsProfile> {
        return contractsProfile(this, domainId);
    }

    /** The domain's static description, read once per domain. */
    info(domainId: number): Promise<ChainInfo> {
        let cached = this.infos.get(domainId);
        if (!cached) {
            cached = this.chainInfo(domainId);
            this.infos.set(domainId, cached);
            cached.catch(() => this.infos.delete(domainId));
        }
        return cached;
    }

    /** Checks the batch's commitments against Settlement when a batch source is set. */
    async getBatch(domainId: number, tag?: Tag): Promise<Batch & { check: { rootChecked: boolean } }> {
        const batch = requireRecord<Batch>("zeno_getBatch", await this.call("zeno_getBatch", withTag([domainId], tag)));
        return { ...batch, check: { rootChecked: await checkBatch("zeno_getBatch", this.roots, batch, tag) } };
    }

    getReceipt(sendHash: Hex): Promise<ReceiptResult> {
        return this.call("zeno_getReceipt", [sendHash]);
    }

    /**
     * Checks that `receipt` is the receipt of `sendHash`, that its
     * `domainId` is the domain the send's call data names, and that its
     * `sender` is the send block's address, against the send block the node
     * holds. At `latest` and `finalized` it also checks the receipt, its
     * return data, events and outbox items against the batch Settlement
     * accepted, and its decoded input against the send block. It does not
     * check `verified`. Returns true when the batch check ran, and false for
     * a `pending` receipt. Throws GatewayVerificationError when a check
     * fails. A returned value, a `batch root` or `finality` failure, and any
     * later failure or gateway read error all mean that the domain and
     * sender checks passed. Every tag needs the `sends` option, and `latest`
     * and `finalized` also need `batches`. It throws `Error` without the
     * option it needs, and when the node has no block for `sendHash`.
     */
    verifyReceipt(sendHash: Hex, receipt: ReceiptResult): Promise<boolean> {
        return checkReceipt(this, this.roots, this.options.sends ?? null, sendHash, receipt);
    }

    async getStateAt(domainId: number, path: Hex, tag?: Tag): Promise<StateResult & { state: StateValue }> {
        const result = requireRecord<StateResult>("zeno_getStateAt", await this.call("zeno_getStateAt", withTag([domainId, path], tag)));
        return { ...result, state: stateValue(result.present, result.value) };
    }

    /** Verifies every proof against the returned root, and against Settlement's root when a batch source is set. */
    async getProof(domainId: number, paths: Hex[], tag?: Tag): Promise<Verified<ProofResult>> {
        const method = "zeno_getProof";
        const result = requireRecord<ProofResult>(method, await this.call(method, withTag([domainId, paths], tag)));
        requireProofs(method, result.proofs);
        if (result.proofs.length !== paths.length || result.proofs.some((p, i) => p.path !== paths[i].toLowerCase())) {
            throw new GatewayVerificationError(method, "paths", "the proofs are not for the requested paths, in order");
        }
        verifyProofs(method, result.postStateRoot, result.proofs);
        const rootChecked = await checkRoot(method, this.roots, result, tag);
        return { ...result, check: { proofs: result.proofs.length, rootChecked, pathsChecked: true } };
    }

    getInputs(filter: InputFilter): Promise<Page<InputItem>> {
        return this.call("zeno_getInputs", [listFilter(filter)]);
    }

    getEvents(filter: EventFilter): Promise<Page<EventItem>> {
        return this.call("zeno_getEvents", [listFilter(filter)]);
    }

    getOutbox(filter: OutboxFilter): Promise<Page<OutboxItem>> {
        return this.call("zeno_getOutbox", [listFilter(filter)]);
    }

    getOutboxProof(outboxId: Hex): Promise<OutboxProofResult> {
        return this.call("zeno_getOutboxProof", [outboxId]);
    }

    getBundle(daHash: Hex): Promise<BundleResult> {
        return this.call("zeno_getBundle", [daHash]);
    }

    getReceiptSidecar(daHash: Hex): Promise<SidecarResult> {
        return this.call("zeno_getReceiptSidecar", [daHash]);
    }

    /** Runs one domain view. `params` is the view's parameter object. */
    async read<T = unknown>(domainId: number, view: string, params?: Record<string, unknown>, tag?: Tag): Promise<Verified<ReadResult<T>>> {
        const method = "zeno_read";
        const args: unknown[] = [domainId, view];
        if (params !== undefined || tag !== undefined) args.push(params ?? {});
        if (tag !== undefined) args.push(encodeTag(tag));
        const result = requireRecord<ReadResult<T>>(method, await this.call(method, args));

        const leaves = verifyProofs(method, result.postStateRoot, result.proofs);
        const rootChecked = await checkRoot(method, this.roots, result, tag);
        let pathsChecked = false;
        if (leaves.length > 0) {
            const derivation = pathDerivationFor((await this.info(domainId)).runtimeKind);
            pathsChecked = derivation?.verifyView(view, params ?? {}, result, leaves) ?? false;
        }
        const check: VerificationReport = { proofs: leaves.length, rootChecked, pathsChecked };
        return { ...result, check };
    }

    /** A would-be receipt for a `CallL2` or `Deposit`. It is never `verified`. */
    simulate(domainId: number, input: SimulateInput, tag?: Tag): Promise<SimulateResult> {
        const wire = { ...input, plasmaLimit: toJsonNumber(input.plasmaLimit, "plasmaLimit") };
        return this.call("zeno_simulate", withTag([domainId, wire], tag));
    }

    /**
     * Subscribes to `heads`, `receipt` or `events`. Returns a function
     * that unsubscribes. Needs a WebSocket connection.
     */
    async subscribe<K extends keyof SubscriptionKinds>(
        kind: K,
        params: SubscriptionKinds[K]["params"],
        handler: (result: SubscriptionKinds[K]["result"]) => void
    ): Promise<() => Promise<void>> {
        const source = this.options.notifications;
        if (!source) {
            throw new Error("subscribe needs a WebSocket gateway URL");
        }
        this.listen(source);

        const args: unknown[] = [kind, ...params];
        if (kind === "events" && args[2] !== undefined) args[2] = encodeTag(args[2] as Tag);
        this.subscribing++;
        let id: string;
        try {
            const result = await this.call<unknown>("zeno_subscribe", args.filter((a) => a !== undefined));
            if (typeof result !== "string" || this.handlers.has(result)) {
                throw new GatewayVerificationError("zeno_subscribe", "result structure", "the subscription id is not a new string");
            }
            id = result;
        } catch (error) {
            this.subscribing--;
            if (this.subscribing === 0) this.clearEarly();
            throw error;
        }

        const deliver = handler as (result: unknown) => void;
        this.handlers.set(id, deliver);
        const queued = this.early.get(id) ?? [];
        this.earlyCount -= queued.length;
        this.early.delete(id);
        this.subscribing--;
        // Results queued for ids no subscribe claimed are dropped once none is in flight.
        if (this.subscribing === 0) this.clearEarly();
        for (const result of queued) {
            try {
                deliver(result);
            } catch (error) {
                this.reportHandlerError(error);
            }
        }

        return async () => {
            if (!this.handlers.delete(id)) return;
            try {
                await this.call<boolean>("zeno_unsubscribe", [id]);
            } catch {
                // The connection may already be gone.
            }
        };
    }

    private listen(source: NotificationSource): void {
        if (this.stopNotifications) return;
        this.stopNotifications = source.onNotification(({ subscription, result }) => {
            const handler = this.handlers.get(subscription);
            if (handler) {
                handler(result);
                return;
            }
            // A notification can arrive before subscribe has stored its
            // handler, so queue it only while a subscribe is in flight.
            if (this.subscribing === 0) return;
            if (this.earlyCount >= EARLY_NOTIFICATION_LIMIT) return;
            this.earlyCount++;
            const queued = this.early.get(subscription);
            if (queued) queued.push(result);
            else this.early.set(subscription, [result]);
        });
    }

    private clearEarly(): void {
        this.early.clear();
        this.earlyCount = 0;
    }

    private reportHandlerError(error: unknown): void {
        try {
            this.options.onError?.(error instanceof Error ? error : new Error(show(error)));
        } catch {
            // A throwing error callback must not break the subscription.
        }
    }
}

/** `latest` is the gateway's default, so a left-out tag adds no parameter. */
function withTag(params: unknown[], tag: Tag | undefined): unknown[] {
    return tag === undefined ? params : [...params, encodeTag(tag)];
}

export function encodeTag(tag: Tag): string | number {
    if (typeof tag === "string") return tag;
    return toJsonNumber(tag, "batch id");
}

function toJsonNumber(value: bigint | number, what: string): number {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) {
        throw new RangeError(`${what} ${show(value)} is not a safe JSON integer`);
    }
    return n;
}

function listFilter(filter: ListFilter): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(filter)) {
        if (value === undefined) continue;
        if (key === "toBatch") out[key] = encodeTag(value as Tag);
        else if (key === "fromBatch") out[key] = toJsonNumber(value as number | bigint, "fromBatch");
        else out[key] = value;
    }
    return out;
}

/** Turns a state result into a value that keeps the absent and present-empty cases apart. */
export function stateValue(present: boolean, value: Hex | null): StateValue {
    if (!present) return { present: false };
    return { present: true, value: hexToBytes(value ?? "", "a state value", (detail) => new ZenoCodecError(detail)) };
}
