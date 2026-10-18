import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { AddressInfo } from "node:net";

export interface RecordedCall {
    name: string;
    method: string;
    params: unknown[];
    response: { jsonrpc: string; id: number; result?: unknown; error?: { code: number; message: string } };
}

export const recorded: RecordedCall[] = JSON.parse(
    readFileSync(new URL("../fixtures/gateway/gateway-go.json", import.meta.url), "utf8")
).calls;

export const call = (name: string): RecordedCall => {
    const found = recorded.find((c) => c.name === name);
    if (!found) throw new Error(`no recorded call named ${name}`);
    return found;
};

export interface Replay {
    url: string;
    /** The requests the server received, in order. */
    requests: { method: string; params: unknown[] }[];
    close(): Promise<void>;
}

/**
 * Serves recorded gateway responses over HTTP. A request is answered by
 * the recorded call with the same method and parameters. Entries in
 * `extra` come first: they answer requests the recording does not cover,
 * or replace a recorded response with a tampered one. A request with
 * no match is answered with -32601 so the client test fails loudly.
 */
export async function startReplay(extra: RecordedCall[] = []): Promise<Replay> {
    const requests: Replay["requests"] = [];
    const all = [...extra, ...recorded];
    const server: Server = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            const request = JSON.parse(body);
            requests.push({ method: request.method, params: request.params });
            const match = all.find((c) => c.method === request.method && isDeepStrictEqual(c.params, request.params));
            const response = match
                ? { ...match.response, id: request.id }
                : { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `no recorded call for ${request.method} ${JSON.stringify(request.params)}` } };
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(response));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

/** A hand-written error response for a code the recording does not reach. */
export const syntheticError = (method: string, params: unknown[], code: number, message: string): RecordedCall => ({
    name: `synthetic ${code}`,
    method,
    params,
    response: { jsonrpc: "2.0", id: 1, error: { code, message } },
});
