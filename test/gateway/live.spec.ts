import { expect } from "chai";
import { GatewayClient } from "../../src/index.js";

// Runs against a live gateway when ZENO_GATEWAY_URL is set, for example
// the one zeno-executor's devnet test starts. ZENO_GATEWAY_DOMAIN selects
// the domain (default 1).
const url = process.env.ZENO_GATEWAY_URL;
const domainId = Number(process.env.ZENO_GATEWAY_DOMAIN ?? "1");

(url ? describe : describe.skip)("GatewayClient against a live gateway", () => {
    let client: GatewayClient;
    before(async () => {
        client = await GatewayClient.connect(url as string);
    });
    after(() => client.close());

    it("answers chainInfo and getHead", async () => {
        const info = await client.chainInfo(domainId);
        expect(info.domainId).to.equal(domainId);
        const head = await client.getHead(domainId);
        expect(["SYNCING", "OK", "INCONSISTENT"]).to.include(head.status);
    });

    it("subscribes to heads over a WebSocket", async function () {
        this.timeout(5_000);
        const socket = await GatewayClient.connect((url as string).replace(/^http/i, "ws"));
        try {
            const unsubscribe = await socket.subscribe("heads", [domainId], () => undefined);
            await unsubscribe();
        } finally {
            socket.close();
        }
    });
});
