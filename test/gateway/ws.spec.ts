import { createServer as createTcpServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { expect } from "chai";
import WebSocket, { WebSocketServer } from "ws";
import { GatewayClient, GatewayProtocolError, GatewayVerificationError, ResponseSizeError } from "../../src/index.js";
import { HttpClient } from "../../src/gateway/http.js";
import { GatewaySocket, MAX_PENDING_REQUESTS } from "../../src/gateway/ws.js";

const LIMIT = 2_000;

interface Server {
    url: string;
    sockets: WebSocket[];
    close(): Promise<void>;
}

/** A gateway that answers `zeno_subscribe` and then sends `notification` for the subscription. */
async function serve(notification: () => string): Promise<Server> {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => wss.once("listening", resolve));
    const sockets: WebSocket[] = [];
    wss.on("connection", (socket) => {
        sockets.push(socket);
        socket.on("message", (data) => {
            const request = JSON.parse(String(data));
            socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "sub-1" }));
            if (request.method === "zeno_subscribe") setTimeout(() => socket.send(notification()), 20);
        });
    });
    return {
        url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
        sockets,
        close: () => new Promise((resolve) => wss.close(() => resolve(undefined))),
    };
}

const note = (padding: number) =>
    JSON.stringify({ jsonrpc: "2.0", method: "zeno_subscription", params: { subscription: "sub-1", result: { pad: "x".repeat(padding) } } });

describe("GatewayClient subscribe over a WebSocket", function () {
    this.timeout(8_000);

    it("delivers a message within the limit", async () => {
        const server = await serve(() => note(100));
        const gateway = await GatewayClient.connect(server.url, { maxResponseSize: LIMIT, timeoutMs: 300 });
        try {
            const got = await new Promise<unknown>((resolve, reject) => {
                gateway.subscribe("heads", [1], resolve).catch(reject);
            });
            expect(got).to.deep.equal({ pad: "x".repeat(100) });
        } finally {
            gateway.close();
            await server.close();
        }
    });

    it("refuses a message over the limit, closes the socket and never reconnects", async () => {
        const server = await serve(() => note(LIMIT * 2));
        const errors: Error[] = [];
        const gateway = await GatewayClient.connect(server.url, { maxResponseSize: LIMIT, timeoutMs: 300, onError: (e) => errors.push(e) });
        const delivered: unknown[] = [];
        try {
            const closed = new Promise<number>((resolve) => server.sockets[0].once("close", resolve));
            await gateway.subscribe("heads", [1], (r) => delivered.push(r));
            expect(await closed).to.equal(1000);
            expect(errors).to.have.length(1);
            expect(errors[0]).to.be.instanceOf(ResponseSizeError);
            expect(errors[0].message).to.match(/^gateway WebSocket message: /);
            expect(delivered).to.deep.equal([]);
            gateway.close();
            await sleep(1_500);
            expect(server.sockets).to.have.length(1);
        } finally {
            gateway.close();
            await server.close();
        }
    });
});

class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    binaryType = "blob";
    sent: string[] = [];
    closed: { code?: number } | null = null;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(public readonly url: string) {
        FakeWebSocket.instances.push(this);
        queueMicrotask(() => this.onopen?.());
    }
    send(data: string): void {
        this.sent.push(data);
    }
    close(code?: number): void {
        this.closed = { code };
    }
    deliver(data: unknown): void {
        this.onmessage?.({ data });
    }
}

describe("GatewayClient over a platform WebSocket", () => {
    const original = globalThis.WebSocket;
    beforeEach(() => {
        FakeWebSocket.instances = [];
        globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket;
    });
    afterEach(() => {
        globalThis.WebSocket = original;
    });

    it("refuses an oversized message before parsing it", async () => {
        const errors: Error[] = [];
        const gateway = await GatewayClient.connect("ws://gateway.test", { maxResponseSize: 100, onError: (e) => errors.push(e) });
        const fake = FakeWebSocket.instances[0];
        const parse = JSON.parse;
        let parsed = 0;
        JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
            parsed++;
            return parse(...args);
        }) as typeof JSON.parse;
        try {
            const pending = gateway.getHead(1);
            const rejected = pending.then(() => null, (e: unknown) => e);
            fake.deliver(`{"pad":"${"x".repeat(200)}"}`);
            expect(await rejected).to.be.instanceOf(ResponseSizeError);
            expect(parsed).to.equal(0);
            expect(fake.closed?.code).to.equal(1000);
            expect(errors[0]).to.be.instanceOf(ResponseSizeError);
        } finally {
            JSON.parse = parse;
        }
    });

    it("counts bytes, not characters", async () => {
        const gateway = await GatewayClient.connect("ws://gateway.test", { maxResponseSize: 100 });
        const fake = FakeWebSocket.instances[0];
        const rejected = gateway.getHead(1).then(() => null, (e: unknown) => e);
        fake.deliver(`"${"é".repeat(60)}"`);
        expect(await rejected).to.be.instanceOf(ResponseSizeError);
    });

    it("refuses a three-byte and a four-byte message over the byte limit", async () => {
        const gateway = await GatewayClient.connect("ws://gateway.test", { maxResponseSize: 100 });
        const fake = FakeWebSocket.instances[0];
        const rejected = gateway.getHead(1).then(() => null, (e: unknown) => e);
        fake.deliver(`"${"\u20ac".repeat(34)}"`);
        expect(await rejected).to.be.instanceOf(ResponseSizeError);
        const second = await GatewayClient.connect("ws://gateway.test", { maxResponseSize: 100 });
        const fakeTwo = FakeWebSocket.instances[1];
        const rejectedTwo = second.getHead(1).then(() => null, (e: unknown) => e);
        fakeTwo.deliver(`"${"\u{1F600}".repeat(26)}"`);
        expect(await rejectedTwo).to.be.instanceOf(ResponseSizeError);
    });

    it("accepts a message of emoji whose byte length equals the limit", async () => {
        const head = '{"jsonrpc":"2.0","id":1,"result":"';
        const text = `${head}${"\u{1F600}".repeat(30)}"}`;
        const gateway = await GatewayClient.connect("ws://gateway.test", { maxResponseSize: Buffer.byteLength(text) });
        const fake = FakeWebSocket.instances[0];
        const answered = gateway.getHead(1);
        fake.deliver(text);
        expect(await answered).to.equal("\u{1F600}".repeat(30));
    });

    it("rejects the request and reports when building its error throws", async function () {
        this.timeout(500);
        const errors: Error[] = [];
        const gateway = await GatewayClient.connect("ws://gateway.test", { timeoutMs: 10_000, onError: (e) => errors.push(e) });
        const fake = FakeWebSocket.instances[0];
        const parse = JSON.parse;
        JSON.parse = ((text: string, ...rest: unknown[]) =>
            text === "boom"
                ? {
                      id: 1,
                      get error(): never {
                          throw new Error("boom");
                      },
                  }
                : (parse as (...args: unknown[]) => unknown)(text, ...rest)) as typeof JSON.parse;
        try {
            const rejected = gateway.getHead(1).then(() => null, (e: unknown) => e);
            fake.deliver("boom");
            expect(await rejected).to.be.instanceOf(GatewayProtocolError);
            expect(errors[0]).to.be.instanceOf(GatewayProtocolError);
        } finally {
            JSON.parse = parse;
        }
    });

    it("answers requests and delivers notifications within the limit", async () => {
        const gateway = await GatewayClient.connect("ws://gateway.test");
        const fake = FakeWebSocket.instances[0];
        const got: unknown[] = [];
        const subscribed = gateway.subscribe("heads", [1], (r) => got.push(r));
        fake.deliver(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "sub-1" }));
        await subscribed;
        fake.deliver(note(5));
        expect(got).to.deep.equal([{ pad: "xxxxx" }]);
        expect(JSON.parse(fake.sent[0])).to.deep.include({ method: "zeno_subscribe", params: ["heads", 1] });
    });

    it("close closes the socket and fails later requests", async () => {
        const gateway = await GatewayClient.connect("ws://gateway.test");
        const fake = FakeWebSocket.instances[0];
        gateway.close();
        expect(fake.closed).to.not.equal(null);
        let failed = false;
        await gateway.getHead(1).catch(() => (failed = true));
        expect(failed).to.equal(true);
        expect(FakeWebSocket.instances).to.have.length(1);
    });
});

interface Hostile {
    url: string;
    sockets: WebSocket[];
    close(): Promise<void>;
}

/** A gateway that hands every request to `onRequest`. */
async function hostile(onRequest: (socket: WebSocket, request: { id: number; method: string; params: unknown[] }) => void): Promise<Hostile> {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => wss.once("listening", resolve));
    const sockets: WebSocket[] = [];
    wss.on("connection", (socket) => {
        sockets.push(socket);
        socket.on("error", () => undefined);
        socket.on("message", (data) => onRequest(socket, JSON.parse(String(data))));
    });
    return {
        url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
        sockets,
        close: async () => {
            for (const socket of sockets) socket.terminate();
            await new Promise((resolve) => wss.close(() => resolve(undefined)));
        },
    };
}

const settle = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as Error & { code?: number; method?: string });
const reply = (socket: WebSocket, id: number, body: Record<string, unknown>) => socket.send(JSON.stringify({ jsonrpc: "2.0", id, ...body }));

describe("a GatewaySocket against a hostile gateway", function () {
    this.timeout(8_000);

    async function connected(server: Hostile, options: { maxResponseSize?: number; timeoutMs?: number } = {}) {
        const errors: Error[] = [];
        const gateway = await GatewayClient.connect(server.url, { timeoutMs: 1_000, ...options, onError: (error) => errors.push(error) });
        return { gateway, errors };
    }

    const raw = (socket: WebSocket) => (socket as unknown as { _socket: { write(bytes: Buffer): void } })._socket;
    const breakers: Record<string, (socket: WebSocket) => void> = {
        "a reserved opcode frame": (socket) => raw(socket).write(Buffer.from([0x83, 0x00])),
        "a text frame with invalid UTF-8": (socket) => raw(socket).write(Buffer.from([0x81, 0x02, 0xff, 0xfe])),
        "a TCP reset with no close frame": (socket) => socket.terminate(),
    };
    for (const [name, breakIt] of Object.entries(breakers)) {
        it(`rejects every request when the gateway sends ${name}`, async () => {
            const server = await hostile((socket) => breakIt(socket));
            const { gateway, errors } = await connected(server);
            try {
                const first = settle(gateway.getHead(1));
                const second = settle(gateway.getHead(2));
                expect(await first).to.be.instanceOf(Error);
                expect(await second).to.be.instanceOf(Error);
                expect(await settle(gateway.getHead(3))).to.be.instanceOf(Error);
                expect(errors).to.have.length(1);
            } finally {
                gateway.close();
                await server.close();
            }
        });
    }

    it("rejects the pending request and calls onError once when the gateway closes", async () => {
        const server = await hostile((socket) => socket.close(1001));
        const { gateway, errors } = await connected(server);
        try {
            expect(await settle(gateway.getHead(1))).to.be.instanceOf(Error);
            expect(errors).to.have.length(1);
        } finally {
            gateway.close();
            await server.close();
        }
    });

    it("does not call onError for a close the caller started", async () => {
        const server = await hostile(() => undefined);
        const { gateway, errors } = await connected(server);
        const pending = settle(gateway.getHead(1));
        gateway.close();
        expect(await pending).to.be.instanceOf(Error);
        await sleep(100);
        expect(errors).to.deep.equal([]);
        await server.close();
    });

    it("turns an error message that cannot be converted to text into a request error", async () => {
        const server = await hostile((socket, { id }) =>
            socket.send(`{"jsonrpc":"2.0","id":${id},"error":{"code":-32004,"message":{"toString":1,"valueOf":1}}}`)
        );
        const { gateway, errors } = await connected(server);
        try {
            const error = await settle(gateway.getHead(1));
            expect(error).to.have.property("code", -32004);
            expect(errors).to.deep.equal([]);
        } finally {
            gateway.close();
            await server.close();
        }
    });

    it("bounds a long error message that has no code", async () => {
        const server = await hostile((socket, { id }) => reply(socket, id, { error: { message: "x".repeat(100_000) } }));
        const { gateway } = await connected(server);
        try {
            const error = await settle(gateway.getHead(1));
            expect(error).to.be.instanceOf(Error);
            expect(error!.message.length).to.be.below(200);
        } finally {
            gateway.close();
            await server.close();
        }
    });

    it("rejects with the code of an error reply, and treats a falsy error as an error", async () => {
        const server = await hostile((socket, { id, params }) =>
            reply(socket, id, params[0] === 1 ? { error: { code: -32004, message: "nope" } } : { error: 0, result: "ignored" })
        );
        const { gateway } = await connected(server);
        try {
            expect(await settle(gateway.getHead(1))).to.have.property("code", -32004);
            expect((await settle(gateway.getHead(2)))!.message).to.equal("0");
        } finally {
            gateway.close();
            await server.close();
        }
    });

    it("closes the socket on a binary message and reports it", async () => {
        const server = await hostile((socket) => socket.send(Buffer.from([1, 2, 3])));
        const { gateway, errors } = await connected(server);
        try {
            expect(await settle(gateway.getHead(1))).to.be.instanceOf(GatewayProtocolError);
            expect(errors).to.have.length(1);
            expect(errors[0]).to.be.instanceOf(GatewayProtocolError);
            expect(errors[0].message).to.match(/binary/);
        } finally {
            gateway.close();
            await server.close();
        }
    });

    it("rejects a subscribe whose id is not a string or is already in use", async () => {
        const ids: unknown[] = [7, "sub-1", "sub-1"];
        const server = await hostile((socket, { id }) => reply(socket, id, { result: ids.shift() }));
        const { gateway } = await connected(server);
        try {
            expect(await settle(gateway.subscribe("heads", [1], () => undefined))).to.be.instanceOf(GatewayVerificationError);
            await gateway.subscribe("heads", [1], () => undefined);
            expect(await settle(gateway.subscribe("heads", [1], () => undefined))).to.be.instanceOf(GatewayVerificationError);
        } finally {
            gateway.close();
            await server.close();
        }
    });

    it("closes the socket on a notification without a subscription id", async () => {
        const server = await hostile((socket) => socket.send('{"jsonrpc":"2.0","method":"zeno_subscription","params":null}'));
        const { gateway, errors } = await connected(server);
        try {
            const error = await settle(gateway.getHead(1));
            expect(error).to.be.instanceOf(Error);
            expect(errors).to.have.length(1);
            expect(errors[0].name).to.equal("GatewayProtocolError");
        } finally {
            gateway.close();
            await server.close();
        }
    });

    for (const [name, message] of [["text that is not JSON", "not json"], ["JSON that is not an object", "[1]"]]) {
        it(`closes the socket on ${name}`, async () => {
            const server = await hostile((socket) => socket.send(message));
            const { gateway, errors } = await connected(server);
            try {
                expect(await settle(gateway.getHead(1))).to.be.instanceOf(Error);
                expect(errors).to.have.length(1);
                expect(errors[0].name).to.equal("GatewayProtocolError");
            } finally {
                gateway.close();
                await server.close();
            }
        });
    }

    it("passes an error from a notification handler to onError and still calls the other handlers", async () => {
        const server = await hostile((socket) => socket.send(note(1)));
        const errors: Error[] = [];
        const socket = await GatewaySocket.open(server.url, 10_000, 1_000, (error) => errors.push(error));
        try {
            const got: unknown[] = [];
            socket.onNotification(() => {
                throw new Error("handler failed");
            });
            socket.onNotification((params) => got.push(params.result));
            void socket.sendRequest("zeno_getHead").catch(() => undefined);
            await sleep(200);
            expect(got).to.deep.equal([{ pad: "x" }]);
            expect(errors.map((e) => e.message)).to.deep.equal(["handler failed"]);
        } finally {
            socket.close();
            await server.close();
        }
    });

    it("rejects a request the gateway never answers", async () => {
        const server = await hostile(() => undefined);
        const { gateway } = await connected(server, { timeoutMs: 200 });
        try {
            const error = await settle(gateway.getHead(1));
            expect(error!.name).to.equal("GatewayProtocolError");
        } finally {
            gateway.close();
            await server.close();
        }
    });

    it("rejects only the request beyond the pending limit and keeps the socket open", async () => {
        const server = await hostile(() => undefined);
        const { gateway, errors } = await connected(server, { timeoutMs: 500 });
        try {
            const first = Array.from({ length: MAX_PENDING_REQUESTS }, (_, i) => settle(gateway.getHead(i)));
            const last = settle(gateway.getHead(MAX_PENDING_REQUESTS));
            const early = await Promise.race([last, sleep(50).then(() => "pending")]);
            expect(early).to.be.instanceOf(Error);
            expect((early as Error).name).to.equal("GatewayProtocolError");
            const timedOut = await Promise.all(first);
            expect(timedOut.every((r) => r?.name === "GatewayProtocolError" && r.message.includes("did not answer"))).to.equal(true);
            expect(errors).to.deep.equal([]);
        } finally {
            gateway.close();
            await server.close();
        }
    });

    it("leaves other requests alone for an unknown id and a repeated id", async () => {
        const server = await hostile((socket, { id }) => {
            reply(socket, 9_999, { result: "stray" });
            reply(socket, id, { result: "first" });
            reply(socket, id, { result: "second" });
        });
        const { gateway, errors } = await connected(server);
        try {
            expect(await gateway.getHead(1)).to.equal("first");
            expect(await gateway.getHead(2)).to.equal("first");
            expect(errors).to.deep.equal([]);
        } finally {
            gateway.close();
            await server.close();
        }
    });

    it("names the method of each request in a size refusal", async () => {
        const server = await hostile((socket, { id }) => reply(socket, id, { result: "x".repeat(LIMIT * 2) }));
        const { gateway } = await connected(server, { maxResponseSize: LIMIT });
        try {
            const error = await settle(gateway.getHead(1));
            expect(error).to.be.instanceOf(ResponseSizeError);
            expect(error!.message).to.contain("zeno_getHead");
        } finally {
            gateway.close();
            await server.close();
        }
    });

    it("reports a non-object error value as the message", async () => {
        const server = await hostile((socket, { id }) => reply(socket, id, { error: "rate limited" }));
        const { gateway } = await connected(server);
        try {
            expect((await settle(gateway.getHead(1)))!.message).to.contain("rate limited");
        } finally {
            gateway.close();
            await server.close();
        }
    });

    it("fails a WebSocket open that times out with a GatewayProtocolError", async () => {
        const held: Socket[] = [];
        const tcp = createTcpServer((socket) => held.push(socket));
        await new Promise((resolve) => tcp.listen(0, "127.0.0.1", () => resolve(undefined)));
        try {
            const error = await settle(GatewayClient.connect(`ws://127.0.0.1:${(tcp.address() as AddressInfo).port}`, { timeoutMs: 100 }));
            expect(error!.name).to.equal("GatewayProtocolError");
        } finally {
            for (const socket of held) socket.destroy();
            tcp.close();
        }
    });

    it("rejects a timeoutMs that setTimeout cannot honour", async () => {
        for (const timeoutMs of [Infinity, NaN, 0, -1, 1.5, 2_147_483_648]) {
            const error = await settle(GatewayClient.connect("ws://gateway.test", { timeoutMs }));
            expect(error, String(timeoutMs)).to.be.instanceOf(RangeError);
        }
    });

    it("rejects a timeoutMs or maxResponseSize that the transports cannot honour, on both transports", async () => {
        for (const timeoutMs of [Infinity, NaN, 0, -1, 1.5, 2_147_483_648]) {
            expect(() => new HttpClient("http://gateway.test", 100, undefined, timeoutMs), String(timeoutMs)).to.throw(RangeError);
            expect(await settle(GatewaySocket.open("ws://gateway.test", 100, timeoutMs)), String(timeoutMs)).to.be.instanceOf(RangeError);
        }
        for (const maxResponseSize of [NaN, 0, -1]) {
            expect(() => new HttpClient("http://gateway.test", maxResponseSize), String(maxResponseSize)).to.throw(RangeError);
            expect(await settle(GatewaySocket.open("ws://gateway.test", maxResponseSize, 1_000)), String(maxResponseSize)).to.be.instanceOf(RangeError);
        }
    });

    it("rejects a connect with a maxResponseSize that never refuses", async () => {
        for (const maxResponseSize of [NaN, 0, -1]) {
            expect(await settle(GatewayClient.connect("ws://gateway.test", { maxResponseSize })), String(maxResponseSize)).to.be.instanceOf(RangeError);
        }
    });

    it("ends the socket when the gateway sends more than the runtime accepts, even with a larger maxResponseSize", async function () {
        this.timeout(20_000);
        const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", maxPayload: 512 * 1024 * 1024 });
        await new Promise((resolve) => wss.once("listening", resolve));
        wss.on("connection", (socket) => {
            socket.on("error", () => undefined);
            socket.on("message", (data) => {
                const { id } = JSON.parse(String(data));
                const head = `{"jsonrpc":"2.0","id":${id},"result":"`;
                socket.send(head + "x".repeat(128 * 1024 * 1024 + 1 - head.length - 2) + '"}');
            });
        });
        const errors: Error[] = [];
        const gateway = await GatewayClient.connect(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, {
            maxResponseSize: 512 * 1024 * 1024,
            timeoutMs: 15_000,
            onError: (error) => errors.push(error),
        });
        try {
            expect(await settle(gateway.getHead(1))).to.be.instanceOf(Error);
            expect(errors).to.have.length(1);
        } finally {
            gateway.close();
            for (const client of wss.clients) client.terminate();
            await new Promise((resolve) => wss.close(() => resolve(undefined)));
        }
    });

    it("forwards the send source to verifyReceipt over a WebSocket connection", async () => {
        const server = await serve(() => note(1));
        const sendHash = "04ee" + "00".repeat(30);
        const client = await GatewayClient.connect(server.url, { sends: async () => { throw new Error("node read"); } });
        try {
            const error = await settle(client.verifyReceipt(sendHash, { tag: "pending", sendHash, domainId: 1 } as never));
            expect(error?.message).to.equal("node read");
        } finally {
            client.close();
            await server.close();
        }
    });

    it("rejects a connect URL that is not http, https, ws or wss", async () => {
        const error = await settle(GatewayClient.connect("ftp://gateway.test"));
        expect(error).to.be.instanceOf(TypeError);
        expect(error!.message).to.contain("must start with");
    });
});

describe("a GatewayClient's early notifications", () => {
    const original = globalThis.WebSocket;
    beforeEach(() => {
        FakeWebSocket.instances = [];
        globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket;
    });
    afterEach(() => {
        globalThis.WebSocket = original;
    });
    const early = (gateway: GatewayClient) => (gateway as unknown as { early: Map<string, unknown[]> }).early;
    const queuedResults = (gateway: GatewayClient) => [...early(gateway).values()].reduce((sum, queue) => sum + queue.length, 0);
    const send = (fake: FakeWebSocket, subscription: string, result: unknown = 1) =>
        fake.deliver(JSON.stringify({ jsonrpc: "2.0", method: "zeno_subscription", params: { subscription, result } }));

    it("caps the results queued across all ids while a subscribe is in flight and clears them afterwards", async () => {
        const gateway = await GatewayClient.connect("ws://gateway.test");
        const fake = FakeWebSocket.instances[0];
        const got: unknown[] = [];
        const subscribed = gateway.subscribe("heads", [1], (r) => got.push(r));
        send(fake, "sub-1");
        for (let i = 0; i < 1_000; i++) send(fake, `unknown-${i}`);
        expect(queuedResults(gateway)).to.equal(16);
        fake.deliver(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "sub-1" }));
        await subscribed;
        expect(got).to.deep.equal([1]);
        expect(early(gateway).size).to.equal(0);
    });

    it("keeps the subscription live and reports to onError when a handler throws on an early result", async () => {
        const errors: Error[] = [];
        const gateway = await GatewayClient.connect("ws://gateway.test", { onError: (e) => errors.push(e) });
        const fake = FakeWebSocket.instances[0];
        const got: unknown[] = [];
        const subscribed = gateway.subscribe("heads", [1], (r) => {
            got.push(r);
            throw new Error(`handler failed on ${r}`);
        });
        send(fake, "sub-1", 1);
        fake.deliver(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "sub-1" }));
        await subscribed;
        send(fake, "sub-1", 2);
        expect(got).to.deep.equal([1, 2]);
        expect(errors.map((e) => e.message)).to.deep.equal(["handler failed on 1", "handler failed on 2"]);
    });

    it("drops a notification for an id no subscribe is waiting for", async () => {
        const gateway = await GatewayClient.connect("ws://gateway.test");
        const fake = FakeWebSocket.instances[0];
        const subscribed = gateway.subscribe("heads", [1], () => undefined);
        fake.deliver(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "sub-1" }));
        const unsubscribe = await subscribed;
        const done = unsubscribe();
        send(fake, "sub-1");
        fake.deliver(JSON.stringify({ jsonrpc: "2.0", id: 2, result: true }));
        await done;
        send(fake, "sub-1");
        expect(early(gateway).size).to.equal(0);
    });

    const answer = (fake: FakeWebSocket, id: number, result: unknown) => fake.deliver(JSON.stringify({ jsonrpc: "2.0", id, result }));

    it("frees the slots of a claimed subscription's results for the subscribes still in flight", async () => {
        const gateway = await GatewayClient.connect("ws://gateway.test");
        const fake = FakeWebSocket.instances[0];
        const got: unknown[] = [];
        const first = gateway.subscribe("heads", [1], () => undefined);
        const second = gateway.subscribe("heads", [2], (r) => got.push(r));
        for (let i = 0; i < 16; i++) send(fake, "sub-1", i);
        answer(fake, 1, "sub-1");
        await first;
        send(fake, "sub-2", "late");
        answer(fake, 2, "sub-2");
        await second;
        expect(got).to.deep.equal(["late"]);
    });

    it("starts the early count again once no subscribe is in flight", async () => {
        const gateway = await GatewayClient.connect("ws://gateway.test");
        const fake = FakeWebSocket.instances[0];
        const first = gateway.subscribe("heads", [1], () => undefined);
        for (let i = 0; i < 16; i++) send(fake, `unknown-${i}`);
        answer(fake, 1, "sub-1");
        await first;
        const got: unknown[] = [];
        const second = gateway.subscribe("heads", [2], (r) => got.push(r));
        send(fake, "sub-2", "early");
        answer(fake, 2, "sub-2");
        await second;
        expect(got).to.deep.equal(["early"]);
    });

    it("resolves subscribe when both the handler and onError throw on an early result", async () => {
        const gateway = await GatewayClient.connect("ws://gateway.test", {
            onError: () => {
                throw new Error("onError failed");
            },
        });
        const fake = FakeWebSocket.instances[0];
        const subscribed = gateway.subscribe("heads", [1], () => {
            throw new Error("handler failed");
        });
        send(fake, "sub-1");
        answer(fake, 1, "sub-1");
        await subscribed;
    });
});
