import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect } from "chai";
import { GatewayClient, ResponseSizeError } from "../../src/index.js";
import { HttpClient } from "../../src/gateway/http.js";

const LIMIT = 10_000;
const CHUNK = 1_000;

interface Stream {
    pulled: number;
    cancelled: boolean;
    aborted: boolean;
    fetch: ConstructorParameters<typeof HttpClient>[2];
}

/** A fetch whose body yields `chunks` chunks of CHUNK bytes, one per read, and reports what the reader took. */
function streaming(chunks: number, headers: Record<string, string> = {}, prefix = '{"jsonrpc":"2.0","id":1,"result":"'): Stream {
    const state = { pulled: 0, cancelled: false, aborted: false } as Stream;
    let sent = 0;
    state.fetch = async (_url, init) => {
        init.signal.addEventListener("abort", () => (state.aborted = true));
        const body = new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    if (sent >= chunks) {
                        controller.close();
                        return;
                    }
                    const text = (sent === 0 ? prefix : "") + "x".repeat(CHUNK);
                    sent++;
                    state.pulled += CHUNK;
                    controller.enqueue(new TextEncoder().encode(text.slice(0, CHUNK)));
                },
                cancel() {
                    state.cancelled = true;
                },
            },
            { highWaterMark: 0 }
        );
        return new Response(body, { headers });
    };
    return state;
}

describe("the gateway HTTP response size limit", () => {
    it("stops reading a body that streams past the limit", async () => {
        const stream = streaming(1_000_000);
        const client = new HttpClient("http://gateway", LIMIT, stream.fetch);
        let error: unknown;
        try {
            await client.sendRequest("zeno_getHead", [1]);
        } catch (e) {
            error = e;
        }
        expect(error).to.be.instanceOf(ResponseSizeError);
        expect((error as ResponseSizeError).check).to.equal("response size");
        expect(stream.cancelled).to.equal(true);
        expect(stream.aborted).to.equal(true);
        expect(stream.pulled).to.be.at.most(LIMIT + CHUNK);
    });

    it("refuses a Content-Length over the limit without reading the body", async () => {
        const stream = streaming(1_000_000, { "content-length": String(LIMIT + 1) });
        const client = new HttpClient("http://gateway", LIMIT, stream.fetch);
        let error: unknown;
        try {
            await client.sendRequest("zeno_getHead", [1]);
        } catch (e) {
            error = e;
        }
        expect(error).to.be.instanceOf(ResponseSizeError);
        expect(stream.cancelled).to.equal(true);
        expect(stream.pulled).to.equal(0);
    });

    it("stops a body that is larger than its Content-Length says", async () => {
        const stream = streaming(1_000_000, { "content-length": "100" });
        const client = new HttpClient("http://gateway", LIMIT, stream.fetch);
        let error: unknown;
        try {
            await client.sendRequest("zeno_getHead", [1]);
        } catch (e) {
            error = e;
        }
        expect(error).to.be.instanceOf(ResponseSizeError);
        expect(stream.cancelled).to.equal(true);
        expect(stream.pulled).to.be.at.most(LIMIT + CHUNK);
    });

    it("returns a result within the limit", async () => {
        const body = '{"jsonrpc":"2.0","id":1,"result":{"status":"OK"}}';
        const client = new HttpClient("http://gateway", LIMIT, async () => new Response(body));
        expect(await client.sendRequest("zeno_getHead", [1])).to.deep.equal({ status: "OK" });
    });

    it("throws a JSON-RPC error with its code", async () => {
        const body = '{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"unknown domain"}}';
        const client = new HttpClient("http://gateway", LIMIT, async () => new Response(body, { status: 400 }));
        let error: unknown;
        try {
            await client.sendRequest("zeno_getHead", [1]);
        } catch (e) {
            error = e;
        }
        expect((error as { code: number }).code).to.equal(-32001);
    });

    it("refuses an oversized response from a real server through connect", async () => {
        const server = createServer((req, res) => {
            req.resume();
            res.setHeader("Content-Type", "application/json");
            res.write('{"jsonrpc":"2.0","id":1,"result":"');
            const timer = setInterval(() => res.write("x".repeat(CHUNK)), 1);
            res.on("close", () => clearInterval(timer));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const { port } = server.address() as AddressInfo;
        const client = await GatewayClient.connect(`http://127.0.0.1:${port}`, { maxResponseSize: LIMIT });
        try {
            let error: unknown;
            try {
                await client.getHead(1);
            } catch (e) {
                error = e;
            }
            expect(error).to.be.instanceOf(ResponseSizeError);
        } finally {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    });
});

describe("the gateway HTTP transport against a hostile server", function () {
    this.timeout(8_000);

    async function serve(handler: Parameters<typeof createServer>[1]) {
        const server = createServer(handler);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const { port } = server.address() as AddressInfo;
        return {
            url: `http://127.0.0.1:${port}`,
            close: async () => {
                server.closeAllConnections();
                await new Promise((resolve) => server.close(resolve));
            },
        };
    }
    const fail = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as Error);

    it("ends a request whose body never finishes", async () => {
        const server = await serve((req, res) => {
            req.resume();
            res.write('{"jsonrpc":"2.0","id":1,"result":"');
        });
        const client = await GatewayClient.connect(server.url, { timeoutMs: 300 });
        try {
            const error = await fail(client.getHead(1));
            expect(error!.name).to.equal("GatewayProtocolError");
        } finally {
            await server.close();
        }
    });

    it("fails a JSON array body", async () => {
        for (const body of ["[]", '[{"jsonrpc":"2.0","id":1,"result":1}]']) {
            const client = new HttpClient("http://gateway", LIMIT, async () => new Response(body));
            expect(await fail(client.sendRequest("zeno_getHead", [1]))).to.be.instanceOf(Error);
        }
    });

    it("ends a request that gets no response", async () => {
        const server = await serve((req) => {
            req.resume();
        });
        const client = await GatewayClient.connect(server.url, { timeoutMs: 300 });
        try {
            expect((await fail(client.getHead(1)))!.name).to.equal("GatewayProtocolError");
        } finally {
            await server.close();
        }
    });

    it("does not follow a redirect", async () => {
        let followed = false;
        const target = await serve((req, res) => {
            followed = true;
            req.resume();
            res.end('{"jsonrpc":"2.0","id":1,"result":"redirected"}');
        });
        const server = await serve((req, res) => {
            req.resume();
            res.writeHead(307, { Location: target.url }).end();
        });
        const client = await GatewayClient.connect(server.url);
        try {
            expect(await fail(client.getHead(1))).to.be.instanceOf(Error);
            expect(followed).to.equal(false);
        } finally {
            await server.close();
            await target.close();
        }
    });

    it("bounds a long error message with no code and survives an object message", async () => {
        const bodies = [
            JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "x".repeat(100_000) } }),
            '{"jsonrpc":"2.0","id":1,"error":{"message":{"toString":1,"valueOf":1}}}',
        ];
        let next = 0;
        const server = await serve((req, res) => {
            req.resume();
            res.end(bodies[next++]);
        });
        const client = await GatewayClient.connect(server.url);
        try {
            const long = await fail(client.getHead(1));
            expect(long!.message.length).to.be.below(200);
            const object = await fail(client.getHead(1));
            expect(object).to.be.instanceOf(Error);
            expect(object).to.not.be.instanceOf(TypeError);
        } finally {
            await server.close();
        }
    });
});

describe("an HttpClient with the default fetch", () => {
    it("calls fetch without the client as its receiver", async () => {
        const original = globalThis.fetch;
        globalThis.fetch = function (this: unknown) {
            if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
            return Promise.resolve(new Response('{"jsonrpc":"2.0","id":1,"result":"ok"}'));
        } as typeof fetch;
        try {
            expect(await new HttpClient("http://gateway.test").sendRequest("zeno_getHead", [1])).to.equal("ok");
        } finally {
            globalThis.fetch = original;
        }
    });
});
