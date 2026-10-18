import { expect } from "chai";
import { settlement } from "znn-typescript-sdk";
import type { Client } from "znn-typescript-sdk";
import {
    DomainInconsistentError,
    GatewayClient,
    GatewayError,
    InvalidParamsError,
    NotFoundError,
    SimulationUnavailableError,
    TagUnavailableError,
    UnknownDomainError,
    UnknownViewError,
    ZenoCodecError,
    encodeTag,
    stateValue,
} from "../../src/index.js";
import type { NotificationSource } from "../../src/index.js";
import { call, startReplay, syntheticError } from "./replay.js";
import type { Replay } from "./replay.js";

const SIMULATE_INPUT = {
    kind: "CallL2" as const,
    sender: "z1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsggv2f",
    targetContract: "00".repeat(32),
    payload: "",
    plasmaLimit: 1000n,
};
const SIMULATE_INPUT_WIRE = { ...SIMULATE_INPUT, plasmaLimit: 1000 };

const strip = <T extends { check?: unknown }>(value: T): Omit<T, "check"> => {
    const rest = { ...value };
    delete rest.check;
    return rest;
};

const result = (name: string) => (call(name).response as { result: Record<string, unknown> }).result;

describe("GatewayClient", () => {
    let replay: Replay;
    let client: GatewayClient;

    before(async () => {
        replay = await startReplay([
            syntheticError("zeno_getBatch", [1, "pending"], -32002, "pending is not served by a remote gateway"),
            syntheticError("zeno_getHead", [7], -32003, "domain 7 is inconsistent"),
            syntheticError("zeno_simulate", [1, SIMULATE_INPUT_WIRE], -32006, "simulation is disabled"),
        ]);
        client = await GatewayClient.connect(replay.url);
    });
    after(async () => {
        client.close();
        await replay.close();
    });

    describe("generic methods", () => {
        it("chainInfo returns the domain's profiles and views", async () => {
            const info = await client.chainInfo(1);
            expect(info).to.deep.equal(result("chainInfo"));
            expect(info.profiles[0].name).to.equal("contracts/1");
            expect(info.views.map((v) => v.name)).to.include.members(["contract", "storage", "contractsByDeployer", "module"]);
        });

        it("getHead returns the three heads and the status", async () => {
            const head = await client.getHead(1);
            expect(head).to.deep.equal(result("getHead"));
            expect(head.status).to.equal("OK");
            expect(head.finalized).to.equal(null);
        });

        it("getBatch defaults to latest and takes a batch id", async () => {
            expect(strip(await client.getBatch(1))).to.deep.equal(result("getBatch latest"));
            expect(strip(await client.getBatch(1, 0n))).to.deep.equal(result("getBatch by id"));
        });

        it("getReceipt returns a receipt, return data and the decoded input", async () => {
            const hash = (call("getReceipt success").params as string[])[0];
            const r = await client.getReceipt(hash);
            expect(r).to.deep.equal(result("getReceipt success"));
            expect(r.receipt.status).to.equal("SUCCESS");
            expect(r.input?.kind).to.equal("DeployContractFinalize");
        });

        it("getStateAt keeps the present and absent cases apart", async () => {
            const [domain, path] = call("getStateAt").params as [number, string];
            const s = await client.getStateAt(domain, path);
            expect(s.present).to.equal(true);
            expect(s.state.present).to.equal(true);
            expect(stateValue(false, null)).to.deep.equal({ present: false });
            const empty = stateValue(true, "");
            expect(empty.present && empty.value.length).to.equal(0);
        });

        it("stateValue refuses a non-hex value as a ZenoCodecError before allocating", () => {
            const started = Date.now();
            expect(() => stateValue(true, { length: 500_000_000 } as unknown as string)).to.throw(ZenoCodecError, "a state value is not even-length hex");
            expect(Date.now() - started).to.be.below(2000);
        });

        it("getProof returns one proof per path", async () => {
            const [domain, paths] = call("getProof").params as [number, string[]];
            const p = await client.getProof(domain, paths);
            expect(strip(p)).to.deep.equal(result("getProof"));
        });

        it("getInputs, getEvents and getOutbox take a filter and return a page", async () => {
            const inputs = call("getInputs by contract").params[0] as { domainId: number; contractId: string };
            expect(await client.getInputs(inputs)).to.deep.equal(result("getInputs by contract"));
            expect(await client.getEvents({ domainId: 1 })).to.deep.equal(result("getEvents"));
            expect((await client.getOutbox({ domainId: 1 })).items).to.deep.equal([]);
        });

        it("getOutboxProof returns a proof that rebuilds the batch outbox root", async () => {
            const id = (call("outbox getOutboxProof 0").params as string[])[0];
            const p = await client.getOutboxProof(id);
            const root = settlement.outboxProofRoot(Buffer.from(p.message, "hex"), Buffer.from(p.inclusionProof, "hex"));
            expect(root.toString()).to.equal(p.outboxRoot);
        });

        it("getBundle and getReceiptSidecar return the raw files", async () => {
            const hash = (call("getBundle").params as string[])[0];
            expect((await client.getBundle(hash)).bundle).to.equal(result("getBundle").bundle);
            expect((await client.getReceiptSidecar(hash)).sidecar).to.equal(result("getReceiptSidecar").sidecar);
        });

        it("read runs a view with a parameter object and an optional tag", async () => {
            const [domain, view, params] = call("read contract").params as [number, string, Record<string, unknown>];
            expect(strip(await client.read(domain, view, params))).to.deep.equal(result("read contract"));
            expect(strip(await client.read(domain, view, params, 0))).to.deep.equal(result("read contract at batch 0"));
        });

        it("sends no tag parameter when none is given", async () => {
            await client.getHead(1);
            await client.getBatch(1);
            const sent = replay.requests.filter((r) => r.method === "zeno_getBatch" && r.params.length === 1);
            expect(sent.length).to.be.greaterThan(0);
        });
    });

    describe("errors", () => {
        const rejects = async (promise: Promise<unknown>) => {
            try {
                await promise;
            } catch (error) {
                return error as GatewayError;
            }
            throw new Error("expected the call to fail");
        };

        it("maps each gateway code to a typed error", async () => {
            expect(await rejects(client.getHead(99))).to.be.instanceOf(UnknownDomainError);
            expect(await rejects(client.getBatch(1, "pending"))).to.be.instanceOf(TagUnavailableError);
            expect(await rejects(client.getHead(7))).to.be.instanceOf(DomainInconsistentError);
            expect(await rejects(client.getReceipt((call("error receipt not found").params as string[])[0]))).to.be.instanceOf(NotFoundError);
            expect(await rejects(client.read(1, "nope", {}))).to.be.instanceOf(UnknownViewError);
            expect(await rejects(client.simulate(1, SIMULATE_INPUT))).to.be.instanceOf(SimulationUnavailableError);
        });

        it("keeps the code and method on the error", async () => {
            const error = await rejects(client.getHead(99));
            expect(error.code).to.equal(-32001);
            expect(error.method).to.equal("zeno_getHead");
            expect(error.message).to.equal("unknown domain 99");
        });

        it("maps invalid params", async () => {
            const bad = await rejects((client as unknown as { call: (m: string, p: unknown[]) => Promise<unknown> }).call("zeno_getHead", []));
            expect(bad).to.be.instanceOf(InvalidParamsError);
        });

        it("passes a transport failure through unchanged", async () => {
            const dead = new GatewayClient({ sendRequest: () => Promise.reject(new Error("socket closed")) } as Client);
            const error = await rejects(dead.getHead(1));
            expect(error).to.not.be.instanceOf(GatewayError);
            expect(error.message).to.equal("socket closed");
        });
    });

    describe("tags", () => {
        it("encodes names as strings and batch ids as JSON integers", () => {
            expect(encodeTag("finalized")).to.equal("finalized");
            expect(encodeTag(7n)).to.equal(7);
            expect(encodeTag(0)).to.equal(0);
        });

        it("rejects a batch id that is not a safe integer", () => {
            expect(() => encodeTag(2n ** 60n)).to.throw(RangeError);
            expect(() => encodeTag(-1)).to.throw(RangeError);
        });
    });

    describe("subscribe", () => {
        class FakeSource implements NotificationSource {
            handler: ((p: { subscription: string; result: unknown }) => void) | null = null;
            onNotification(handler: (p: { subscription: string; result: unknown }) => void) {
                this.handler = handler;
                return () => {
                    this.handler = null;
                };
            }
        }

        const rig = () => {
            const source = new FakeSource();
            const sent: { method: string; params: unknown[] }[] = [];
            const rpc = {
                sendRequest: async (method: string, params: unknown[] = []) => {
                    sent.push({ method, params });
                    return method === "zeno_subscribe" ? "sub-1" : true;
                },
            } as Client;
            return { source, sent, gateway: new GatewayClient(rpc, { notifications: source }) };
        };

        it("needs a notification source", async () => {
            const gateway = new GatewayClient({ sendRequest: async () => "x" } as Client);
            let failed = false;
            try {
                await gateway.subscribe("heads", [1], () => undefined);
            } catch {
                failed = true;
            }
            expect(failed).to.equal(true);
        });

        it("delivers notifications for its subscription id only", async () => {
            const { source, sent, gateway } = rig();
            const got: unknown[] = [];
            await gateway.subscribe("heads", [1], (r) => got.push(r));
            expect(sent[0]).to.deep.equal({ method: "zeno_subscribe", params: ["heads", 1] });
            source.handler?.({ subscription: "other", result: "ignored" });
            source.handler?.({ subscription: "sub-1", result: { domainId: 1 } });
            expect(got).to.deep.equal([{ domainId: 1 }]);
        });

        it("encodes the events tag", async () => {
            const { sent, gateway } = rig();
            await gateway.subscribe("events", [{ domainId: 1 }, 5n], () => undefined);
            expect(sent[0].params).to.deep.equal(["events", { domainId: 1 }, 5]);
        });

        it("stops delivery and unsubscribes", async () => {
            const { source, sent, gateway } = rig();
            const got: unknown[] = [];
            const stop = await gateway.subscribe("receipt", ["ab".repeat(32)], (r) => got.push(r));
            await stop();
            source.handler?.({ subscription: "sub-1", result: { tag: "latest" } });
            expect(got).to.deep.equal([]);
            expect(sent[sent.length - 1]).to.deep.equal({ method: "zeno_unsubscribe", params: ["sub-1"] });
        });

        it("reports a receipt as pending, latest and finalized in turn", async () => {
            const { source, gateway } = rig();
            const tags: string[] = [];
            await gateway.subscribe("receipt", ["ab".repeat(32)], (r) => tags.push(r.tag));
            for (const tag of ["pending", "latest", "finalized"]) {
                source.handler?.({ subscription: "sub-1", result: { domainId: 1, batchId: 3, daHash: "", sendHash: "", tag, verified: tag !== "pending", removed: false } });
            }
            expect(tags).to.deep.equal(["pending", "latest", "finalized"]);
        });

        it("keeps a notification that arrives before the handler is stored", async () => {
            const source = new FakeSource();
            const rpc = {
                sendRequest: async (method: string) => {
                    if (method === "zeno_subscribe") {
                        source.handler?.({ subscription: "sub-1", result: { early: true } });
                        return "sub-1";
                    }
                    return true;
                },
            } as Client;
            const gateway = new GatewayClient(rpc, { notifications: source });
            const got: unknown[] = [];
            await gateway.subscribe("heads", [1], (r) => got.push(r));
            expect(got).to.deep.equal([{ early: true }]);
        });
    });
});
