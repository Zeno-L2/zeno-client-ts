import { Address, Hash } from "znn-typescript-sdk";
import { GatewayVerificationError } from "../gateway/errors.js";
import type { ReadResult } from "../gateway/types.js";
import { requireRecord, toHex } from "../gateway/verify.js";
import { hexToBytes } from "../bytes.js";
import type { ProvenLeaf } from "../gateway/verify.js";
import { l1Caller, smtKey } from "../derive.js";
import type { PathDerivation } from "./registry.js";
import { show } from "../format.js";

// Reserved local keys of a WASM contract, matched exactly.
const CODE_HASH = Uint8Array.of(0x00, 0x01);
const SOURCE_CODE_HASH = Uint8Array.of(0x00, 0x02);
const UPGRADE_POLICY = Uint8Array.of(0x00, 0x03);
const OWNER = Uint8Array.of(0x00, 0x04);
const QUOTA = Uint8Array.of(0x00, 0x05);

interface ContractResult {
    codeHash: string | null;
    sourceCodeHash: string | null;
    upgradePolicy: string | null;
    owner: string | null;
    ownerCaller: string | null;
    quota: { purchased: number; used: number } | null;
}

function fail(view: string, detail: string): never {
    throw new GatewayVerificationError("zeno_read", "path derivation", `${view}: ${detail}`);
}

const expectLeaves = (view: string, leaves: ProvenLeaf[], paths: Hash[]) => {
    if (leaves.length !== paths.length) fail(view, `expected ${show(paths.length)} proofs, got ${show(leaves.length)}`);
    paths.forEach((path, i) => {
        if (leaves[i].path !== path.toString()) fail(view, `proof ${show(i)} is for ${show(leaves[i].path)}, not the derived path ${show(path.toString())}`);
    });
};

const hashLeaf = (view: string, name: string, leaf: ProvenLeaf): string | null => {
    if (leaf.value === null) return null;
    if (leaf.value.length !== 32) fail(view, `the ${name} leaf is ${show(leaf.value.length)} bytes, not 32`);
    return toHex(leaf.value);
};

function contractView(params: Record<string, unknown>, read: ReadResult, leaves: ProvenLeaf[]): void {
    const id = Hash.parse(String(params.contractId));
    const keys = [CODE_HASH, SOURCE_CODE_HASH, UPGRADE_POLICY, OWNER, QUOTA];
    expectLeaves("contract", leaves, keys.map((k) => smtKey(id, k)));

    const [codeL, sourceL, policyL, ownerL, quotaL] = leaves;
    const got = requireRecord<ContractResult>("zeno_read", read.result);

    let policy: string | null = null;
    if (policyL.value !== null) {
        if (policyL.value.length !== 1 || policyL.value[0] > 1) fail("contract", "the UpgradePolicy leaf is not 0 or 1");
        policy = policyL.value[0] === 1 ? "OWNER_UPGRADEABLE" : "IMMUTABLE";
    }
    const codeHash = hashLeaf("contract", "CodeHash", codeL);
    let quota: ContractResult["quota"] = null;
    if (codeHash !== null) {
        quota = { purchased: 0, used: 0 };
        if (quotaL.value !== null) {
            if (quotaL.value.length !== 16) fail("contract", `the Quota leaf is ${show(quotaL.value.length)} bytes, not 16`);
            const view = new DataView(quotaL.value.buffer, quotaL.value.byteOffset, 16);
            quota = { purchased: Number(view.getBigUint64(0)), used: Number(view.getBigUint64(8)) };
        }
    }
    const expected: Omit<ContractResult, "owner"> = {
        codeHash,
        sourceCodeHash: hashLeaf("contract", "PreCodeHash", sourceL),
        upgradePolicy: policy,
        ownerCaller: hashLeaf("contract", "Owner", ownerL),
        quota,
    };
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
        if (JSON.stringify(got[key]) !== JSON.stringify(expected[key])) {
            fail("contract", `${key} is ${show(got[key])}, the proven leaves give ${show(expected[key])}`);
        }
    }
    // The owner's address comes from the input history, so the proven
    // owner leaf (a caller hash) is what vouches for it.
    if (got.owner !== null) {
        if (expected.ownerCaller === null) fail("contract", "an owner is named but the owner leaf is absent");
        let owner: Address;
        try {
            owner = Address.parse(got.owner);
        } catch {
            fail("contract", "the owner is not an address");
        }
        if (toHex(l1Caller(owner).getBytes()) !== expected.ownerCaller) {
            fail("contract", "the owner address does not hash to the proven owner caller");
        }
    } else if (expected.ownerCaller !== null) {
        fail("contract", "the owner leaf is present but no owner address is named");
    }
}

function storageView(params: Record<string, unknown>, read: ReadResult, leaves: ProvenLeaf[]): void {
    const id = Hash.parse(String(params.contractId));
    const key = hexToBytes(params.key, "the storage key", (detail) => new GatewayVerificationError("zeno_read", "path derivation", `storage: ${detail}`));
    expectLeaves("storage", leaves, [smtKey(id, key)]);
    const got = requireRecord<{ present: boolean; value: string | null }>("zeno_read", read.result);
    const leaf = leaves[0];
    const present = leaf.value !== null;
    const value = leaf.value === null ? null : toHex(leaf.value);
    if (got.present !== present || got.value !== value) {
        fail("storage", "the result does not match the proven leaf");
    }
}

/** Path derivation of the WASM runtime (`runtimeKind` "WASM"). */
export const wasmPathDerivation: PathDerivation = {
    runtimeKind: "WASM",
    verifyView(view, params, read, leaves) {
        if (view === "contract") {
            contractView(params, read, leaves);
            return true;
        }
        if (view === "storage") {
            storageView(params, read, leaves);
            return true;
        }
        return false;
    },
};
