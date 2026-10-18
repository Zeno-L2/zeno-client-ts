import type { Client } from "znn-typescript-sdk";
import { GatewayProtocolError, ResponseSizeError } from "./errors.js";
import { checkMaxSize, checkTimeout } from "./limits.js";
import { replyError } from "./reply.js";

/** The most bytes one gateway response may hold: 64 MiB. */
export const DEFAULT_MAX_RESPONSE_SIZE = 64 * 1024 * 1024;

/** How long one gateway request, or a WebSocket open, may take: 30 s. */
export const DEFAULT_TIMEOUT_MS = 30_000;

type Fetch = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: "error" }) => Promise<Response>;

/**
 * JSON-RPC over HTTP that refuses a response over `maxResponseSize`
 * bytes. It checks `Content-Length` first, then counts the bytes of the
 * body as they arrive and aborts the request once the count passes the
 * limit, so a larger body is never held in memory. A request, body
 * read included, ends after `timeoutMs`. A redirect fails the request.
 */
export class HttpClient implements Client {
    private nextId = 1;

    constructor(
        private readonly url: string,
        private readonly maxResponseSize: number = DEFAULT_MAX_RESPONSE_SIZE,
        private readonly fetchImpl: Fetch = (input, init) => globalThis.fetch(input, init),
        private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS
    ) {
        checkMaxSize(maxResponseSize);
        checkTimeout(timeoutMs);
    }

    async sendRequest(method: string, parameters: unknown[] = []): Promise<unknown> {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), this.timeoutMs);
        try {
            return await this.exchange(method, parameters, abort);
        } catch (error) {
            if (abort.signal.aborted && !(error instanceof ResponseSizeError)) {
                throw new GatewayProtocolError(`${method}: the gateway did not answer within ${this.timeoutMs} ms`);
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    private async exchange(method: string, parameters: unknown[], abort: AbortController): Promise<unknown> {
        const response = await this.fetchImpl(this.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params: parameters }),
            signal: abort.signal,
            redirect: "error",
        });
        const text = await this.readBounded(method, response, abort);

        let reply: { result?: unknown; error?: unknown } | null = null;
        try {
            reply = JSON.parse(text);
        } catch {
            // Reported below with the HTTP status.
        }
        if (reply === null || typeof reply !== "object" || Array.isArray(reply)) {
            throw new Error(`the gateway answered HTTP ${response.status} with a body that is not a JSON-RPC reply`);
        }
        const error = replyError(reply);
        if (error) throw error;
        return reply.result;
    }

    private async readBounded(method: string, response: Response, abort: AbortController): Promise<string> {
        const limit = this.maxResponseSize;
        const refuse = async (reader?: ReadableStreamDefaultReader<Uint8Array>): Promise<never> => {
            await reader?.cancel().catch(() => undefined);
            abort.abort();
            throw new ResponseSizeError(method, limit);
        };

        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > limit) {
            await response.body?.cancel().catch(() => undefined);
            return refuse();
        }
        if (!response.body) return "";

        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > limit) return refuse(reader);
            chunks.push(value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return new TextDecoder().decode(bytes);
    }
}
