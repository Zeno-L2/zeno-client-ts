import type { Client } from "znn-typescript-sdk";
import { show } from "../format.js";
import { GatewayProtocolError, ResponseSizeError } from "./errors.js";
import { checkMaxSize, checkTimeout } from "./limits.js";
import { replyError } from "./reply.js";
import type { NotificationSource } from "./client.js";

const NOTIFICATION_METHOD = "zeno_subscription";
const NORMAL_CLOSURE = 1000;
const MESSAGE_LABEL = "gateway WebSocket message";

/** The most requests one socket may have awaiting an answer. Another request is rejected. */
export const MAX_PENDING_REQUESTS = 1024;

type Notification = { subscription: string; result: unknown };
type Pending = { method: string; timer: ReturnType<typeof setTimeout>; resolve: (result: unknown) => void; reject: (error: unknown) => void };
type Message = { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };

/**
 * JSON-RPC over the platform `WebSocket` for the gateway. Every pending
 * request settles once: on its reply, after `timeoutMs`, or when the
 * socket errors or closes. A message over `maxMessageSize`, or one that
 * is not JSON-RPC, closes the socket. A request beyond
 * `MAX_PENDING_REQUESTS` is rejected and the socket stays open. A close
 * the caller did not start, and a handler that throws, are reported to
 * `onError`. The socket never reconnects: a closed socket ends its
 * subscriptions, and later requests fail with the error that ended it.
 * The size check runs after the runtime has received the whole message.
 * From Node 22.23.0, 24.17.0 and 26.1.0, undici's default
 * `maxPayloadSize` (128 MiB) makes the runtime fail the connection
 * first, so requests and `onError` get `the gateway WebSocket failed`
 * and a larger `maxMessageSize` has no effect there. Earlier Node
 * releases have no such limit, and a browser buffers each whole message.
 */
export class GatewaySocket implements Client, NotificationSource {
    private readonly pending = new Map<number, Pending>();
    private readonly handlers = new Set<(params: Notification) => void>();
    private nextId = 1;
    private failure: Error | null = null;

    private constructor(
        private readonly socket: WebSocket,
        private readonly maxMessageSize: number,
        private readonly timeoutMs: number,
        private readonly onError?: (error: Error) => void
    ) {
        socket.onmessage = (event) => this.receive(event.data);
        socket.onerror = () => this.end(new Error("the gateway WebSocket failed"), true);
        socket.onclose = () => this.end(new Error("the gateway WebSocket is closed"), true);
    }

    static async open(url: string, maxMessageSize: number, timeoutMs: number, onError?: (error: Error) => void): Promise<GatewaySocket> {
        checkMaxSize(maxMessageSize);
        checkTimeout(timeoutMs);
        const Socket = globalThis.WebSocket;
        if (!Socket) throw new Error("this runtime has no WebSocket, so use an http(s) gateway URL or a runtime with a global WebSocket");
        return new Promise((resolve, reject) => {
            const socket = new Socket(url);
            socket.binaryType = "arraybuffer";
            const timer = setTimeout(() => fail(new GatewayProtocolError(`the gateway WebSocket did not open within ${timeoutMs} ms`)), timeoutMs);
            const fail = (error: Error) => {
                clearTimeout(timer);
                socket.onopen = socket.onerror = socket.onclose = null;
                socket.close();
                reject(error);
            };
            socket.onerror = () => fail(new Error("the gateway WebSocket failed to open"));
            socket.onclose = () => fail(new Error("the gateway WebSocket closed before it opened"));
            socket.onopen = () => {
                clearTimeout(timer);
                resolve(new GatewaySocket(socket, maxMessageSize, timeoutMs, onError));
            };
        });
    }

    sendRequest(method: string, parameters: unknown[] = []): Promise<unknown> {
        if (this.failure) return Promise.reject(this.failure);
        if (this.pending.size >= MAX_PENDING_REQUESTS) {
            return Promise.reject(new GatewayProtocolError(`${method}: more than ${MAX_PENDING_REQUESTS} requests are awaiting an answer`));
        }
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new GatewayProtocolError(`${method}: the gateway did not answer within ${this.timeoutMs} ms`));
            }, this.timeoutMs);
            this.pending.set(id, { method, timer, resolve, reject });
            try {
                this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: parameters }));
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            }
        });
    }

    onNotification(handler: (params: Notification) => void): () => void {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }

    close(): void {
        this.end(new Error("the gateway WebSocket is closed"), false);
    }

    private receive(data: unknown): void {
        if (this.failure) return;
        try {
            this.dispatch(data);
        } catch (error) {
            this.end(new GatewayProtocolError(`the gateway sent a message that could not be handled: ${show(error)}`), true);
        }
    }

    private dispatch(data: unknown): void {
        if (typeof data !== "string") {
            this.end(new GatewayProtocolError("the gateway sent a binary message"), true);
            return;
        }
        if (exceeds(data, this.maxMessageSize)) {
            this.end(new ResponseSizeError(MESSAGE_LABEL, this.maxMessageSize), true, (method) => new ResponseSizeError(method, this.maxMessageSize));
            return;
        }
        let message: Message;
        try {
            message = JSON.parse(data);
        } catch {
            this.end(new GatewayProtocolError("the gateway sent a message that is not JSON"), true);
            return;
        }
        if (message === null || typeof message !== "object" || Array.isArray(message)) {
            this.end(new GatewayProtocolError("the gateway sent a message that is not a JSON-RPC object"), true);
            return;
        }

        if (message.method === NOTIFICATION_METHOD) {
            const params = message.params as Partial<Notification> | null | undefined;
            if (params === null || typeof params !== "object" || typeof params.subscription !== "string") {
                this.end(new GatewayProtocolError("the gateway sent a subscription notification without a subscription id"), true);
                return;
            }
            for (const handler of [...this.handlers]) {
                try {
                    handler(params as Notification);
                } catch (error) {
                    this.report(error);
                }
            }
            return;
        }
        // A reply for an id never sent, or already answered, is dropped.
        const id = message.id;
        const request = typeof id === "number" ? this.pending.get(id) : undefined;
        if (!request) return;
        const error = replyError(message);
        this.pending.delete(id as number);
        clearTimeout(request.timer);
        if (error) request.reject(error);
        else request.resolve(message.result);
    }

    /**
     * Closes the socket once, fails the pending requests (each with
     * `forPending(method)` when given) and drops the handlers. `report`
     * passes `error` to `onError`.
     */
    private end(error: Error, report: boolean, forPending?: (method: string) => Error): void {
        if (this.failure) return;
        this.failure = error;
        this.socket.onmessage = this.socket.onerror = this.socket.onclose = null;
        try {
            this.socket.close(NORMAL_CLOSURE);
        } catch {
            // The socket is already closed.
        }
        const requests = [...this.pending.values()];
        this.pending.clear();
        this.handlers.clear();
        for (const request of requests) {
            clearTimeout(request.timer);
            request.reject(forPending ? forPending(request.method) : error);
        }
        if (report) this.report(error);
    }

    private report(error: unknown): void {
        try {
            this.onError?.(error instanceof Error ? error : new Error(show(error)));
        } catch {
            // A throwing error callback must not break the socket.
        }
    }
}

/** Whether a message holds more than `max` bytes, counted without copying the string. */
function exceeds(data: string, max: number): boolean {
    if (data.length > max) return true;
    if (data.length * 3 <= max) return false;
    let bytes = 0;
    for (let i = 0; i < data.length; i++) {
        const unit = data.charCodeAt(i);
        if (unit < 0x80) bytes += 1;
        else if (unit < 0x800) bytes += 2;
        else if (unit >= 0xd800 && unit < 0xdc00 && i + 1 < data.length && (data.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
            bytes += 4;
            i++;
        } else bytes += 3;
        if (bytes > max) return true;
    }
    return false;
}
