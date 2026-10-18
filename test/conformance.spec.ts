import { expect } from "chai";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Address, Hash, TokenStandard, settlement } from "znn-typescript-sdk";
import {
    CanonicalInput,
    ZenoCodecError,
    decodeBundle,
    decodeExecutionResult,
    decodeMetadata,
    decodeOutboxMessage,
    encodeInput,
    encodeMetadata,
    inputHash,
    inputRoot,
    merkleRoot,
    sha3,
} from "../src/index.js";

// Asset ids are implemented by go-zenon, so the znn SDK owns them. The
// conformance vectors still check that implementation.
const { assetIdFromZts, ztsFromAssetId } = settlement;

interface Vector {
    id: string;
    [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const SOURCE_SHA256 = "450a5c626b002da434e0c05bda998fcb1a834cc6e09ecb31ce27142ba07caaa4";
const source = readFileSync(new URL("./fixtures/serialization-conformance-v1.json", import.meta.url), "utf8");
const vectors: Vector[] = JSON.parse(source).vectors;

const bytes = (hexString: string) => Uint8Array.from(Buffer.from(hexString, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const NO_COMMITMENT_READER =
    "no TypeScript client reads a BatchCommitment, and its decoder belongs in znn-typescript-sdk";
const SKIPPED = new Map<string, string>([
    ["CV-COMMIT-1", NO_COMMITMENT_READER],
    ["CV-COMMIT-2", NO_COMMITMENT_READER],
]);

// settlement.outboxProofRoot is the SDK's SPEC §27.3 MerkleProof fold. The
// SDK owns it because go-zenon verifies relay proofs with it.
const foldsTo = (root: string, element: Uint8Array, proof: Uint8Array): boolean => {
    try {
        return settlement.outboxProofRoot(element, proof).toString() === root;
    } catch {
        return false;
    }
};

const noCheck = (v: Vector): never => {
    throw new Error(`no ${v.expect} check for ${v.structure}`);
};

const rejectsAll = (v: Vector, decode: (data: Uint8Array) => unknown) => {
    const cases: { name: string; encoded_hex: string }[] = v.rejected
        ? v.rejected.map((c: Vector) => ({ name: c.case, encoded_hex: c.encoded_hex }))
        : [{ name: v.id, encoded_hex: v.encoded_hex }];
    for (const c of cases) {
        expect(() => decode(bytes(c.encoded_hex)), c.name).to.throw(ZenoCodecError);
    }
};

const CHECKS = new Map<string, (v: Vector) => void>([
    ["ContractMetadata", (v) => {
        if (v.expect === "accept") {
            const decoded = decodeMetadata(bytes(v.encoded_hex));
            expect(decoded.upgradePolicy).to.equal(v.fields.upgrade_policy);
            expect(hex(decoded.owner.getBytes())).to.equal(v.fields.owner_hex);
            expect(hex(encodeMetadata(decoded))).to.equal(v.encoded_hex);
        } else if (v.expect === "reject") {
            for (const bad of v.rejected) {
                expect(() => decodeMetadata(bytes(bad.encoded_hex)), bad.reject_reason).to.throw(ZenoCodecError);
            }
        } else noCheck(v);
    }],
    ["AssetID", (v) => {
        if (v.expect === "accept") {
            const zts = TokenStandard.parse(v.zts_bech32);
            expect(hex(zts.core)).to.equal(v.zts_hex);
            expect(assetIdFromZts(zts).toString()).to.equal(v.asset_id_hex);
            expect(ztsFromAssetId(Hash.parse(v.asset_id_hex)).toString()).to.equal(v.zts_bech32);
        } else if (v.expect === "reject") {
            for (const bad of v.rejected_asset_ids_hex) {
                expect(() => ztsFromAssetId(Hash.parse(bad)), bad).to.throw();
            }
        } else noCheck(v);
    }],
    ["OutboxMessage", (v) => {
        if (v.expect !== "reject") noCheck(v);
        rejectsAll(v, decodeOutboxMessage);
    }],
    ["ExecutionResult", (v) => {
        if (v.expect === "accept") decodeExecutionResult(bytes(v.encoded_hex));
        else if (v.expect === "reject") rejectsAll(v, decodeExecutionResult);
        else noCheck(v);
    }],
    ["Input", (v) => {
        if (v.expect !== "accept") noCheck(v);
        for (const input of v.inputs) {
            const encoded = bytes(input.encoded_hex);
            const sourceHash = new Hash(Buffer.from(encoded.slice(1, 33)));
            const rebuilt = encodeInput(sourceHash, parseInput(input.kind, encoded));
            expect(hex(rebuilt), input.kind).to.equal(input.encoded_hex);
            expect(inputHash(sourceHash, parseInput(input.kind, encoded)).toString(), input.kind)
                .to.equal(input.input_hash_hex);
        }
        const encodedInputs: Uint8Array[] = v.inputs.map((i: Vector) => bytes(i.encoded_hex));
        expect(inputRoot(encodedInputs).toString()).to.equal(v.expected_input_root);
        v.proofs_hex.forEach((proofHex: string, i: number) => {
            const proof = bytes(proofHex);
            expect(foldsTo(v.expected_input_root, encodedInputs[i], proof), `proof ${i}`).to.equal(true);
            const flipped = Uint8Array.from(proof);
            flipped[flipped.length - 1] ^= 0x01;
            expect(foldsTo(v.expected_input_root, encodedInputs[i], flipped), `flipped proof ${i}`).to.equal(false);
        });
        const prefix = v.prefix_proofs_hex.length;
        expect(merkleRoot(encodedInputs.slice(0, prefix)).toString()).to.equal(v.prefix_root);
        v.prefix_proofs_hex.forEach((proofHex: string, i: number) => {
            expect(foldsTo(v.prefix_root, encodedInputs[i], bytes(proofHex)), `prefix proof ${i}`).to.equal(true);
        });
    }],
    ["MerkleProof", (v) => {
        if (v.expect !== "reject") noCheck(v);
        for (const bad of v.rejected) {
            expect(foldsTo(bad.root, bytes(bad.element_hex), bytes(bad.proof_hex)), bad.case).to.equal(false);
        }
    }],
    ["BundleInputRecord", (v) => {
        if (v.expect !== "accept") noCheck(v);
        const bundle = bytes(v.bundle_hex);
        const records = decodeBundle(bundle);
        expect(records).to.have.length(v.records.length);
        v.records.forEach((want: Vector, i: number) => {
            const got = records[i];
            expect(got.globalInputIndex, `record ${i}`).to.equal(BigInt(want.global_input_index));
            expect(hex(got.inputData), `record ${i} input`).to.equal(want.input_hex);
            expect(hex(got.executionResult), `record ${i} result`).to.equal(want.execution_result_hex);
            const result = decodeExecutionResult(got.executionResult);
            expect(got.witnesses.map((w) => w.key.toString()), `record ${i} keys`).to.deep.equal(want.observed_keys ?? []);
            expect(got.deployChunkData ? hex(got.deployChunkData) : null, `record ${i} chunk`)
                .to.equal(want.deploy_chunk_data_hex ?? null);
            if (i === 0 && v.pre_state_root) expect(result.preStateRoot.toString()).to.equal(v.pre_state_root);
        });
        expect(hex(sha3(bundle))).to.equal(v.expected_da_hash);
    }],
]);

describe("serialization-conformance-v1", () => {
    it("is the vendored copy of the specification artifact", () => {
        expect(createHash("sha256").update(source).digest("hex")).to.equal(SOURCE_SHA256);
    });

    it("skips exactly the vectors no check handles", () => {
        const unhandled = vectors.filter((v) => !CHECKS.has(v.structure)).map((v) => v.id);
        expect(unhandled.sort()).to.deep.equal([...SKIPPED.keys()].sort());
    });

    for (const v of vectors) {
        const title = `${v.id} (${v.structure}, ${v.expect})`;
        const reason = SKIPPED.get(v.id);
        if (reason) {
            it.skip(`${title}: ${reason}`);
            continue;
        }
        it(title, () => {
            const check = CHECKS.get(v.structure);
            if (!check) throw new Error(`no check for structure ${v.structure}`);
            check(v);
        });
    }
});

// Reads the tail fields of a vector's canonical input back into a CanonicalInput.
function parseInput(kind: string, encoded: Uint8Array): CanonicalInput {
    const tail = encoded.slice(33);
    const h = (offset: number) => new Hash(Buffer.from(tail.slice(offset, offset + 32)));
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    const u256 = (offset: number) => BigInt("0x" + hex(tail.slice(offset, offset + 32)));
    switch (kind) {
        case "CallL2": {
            const len = view.getUint32(104, false);
            return {
                kind: 0, targetContract: h(0), plasmaLimit: view.getBigUint64(32, false),
                depositAsset: h(40), depositAmount: u256(72), payload: tail.slice(108, 108 + len),
            };
        }
        case "Deposit":
            return {
                kind: 1, targetContract: h(0), plasmaLimit: view.getBigUint64(32, false),
                depositAsset: h(40), depositAmount: u256(72),
            };
        case "DeployStart": {
            const len = view.getUint32(76, false);
            return {
                kind: 2, codeHash: h(0), metadataHash: h(32), totalSize: view.getBigUint64(64, false),
                chunkCount: view.getUint32(72, false), metadata: tail.slice(80, 80 + len),
            };
        }
        case "DeployChunk":
            return { kind: 3, codeHash: h(0), chunkIndex: view.getUint32(32, false), chunkHash: h(36) };
        case "DeployFinalize":
            return { kind: 4, codeHash: h(0) };
        case "Upgrade":
            return { kind: 5, contractId: h(0), newCodeHash: h(32) };
        case "TransferContractOwnership":
            return { kind: 6, contractId: h(0), newOwner: Address.fromCore(Buffer.from(tail.slice(32, 52))) };
        case "BuyStorage":
            return { kind: 7, contractId: h(0), bytes: view.getBigUint64(32, false) };
        default:
            throw new Error(`unknown kind ${kind}`);
    }
}
