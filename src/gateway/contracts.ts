import { hexToBytes } from "../bytes.js";
import { sha3 } from "../derive.js";
import { GatewayVerificationError, UnsupportedProfileError } from "./errors.js";
import type { GatewayClient } from "./client.js";
import type { Verified } from "./verify.js";
import { requireRecord, toHex } from "./verify.js";
import type { Hex, ProfileInfo, ReadResult, Tag } from "./types.js";
import { show } from "../format.js";

export const CONTRACTS_PROFILE = "contracts/1";

/** The flags of the `contracts/1` profile. A flag the domain does not set is false. */
export interface ContractFeatures {
    upgrade: boolean;
    ownershipTransfer: boolean;
    storageQuota: boolean;
    payableCalls: boolean;
    deposits: boolean;
    nativeAddresses: boolean;
}

export interface ContractView {
    codeHash: Hex | null;
    sourceCodeHash: Hex | null;
    upgradePolicy: "IMMUTABLE" | "OWNER_UPGRADEABLE" | null;
    owner: string | null;
    ownerCaller: Hex | null;
    quota: { purchased: number; used: number } | null;
    nativeAddress: string | null;
}

export interface StorageView {
    present: boolean;
    value: Hex | null;
}

export interface DeployedContract {
    contractId: Hex;
    sendHash: Hex;
    globalInputIndex: number;
    batchId: number;
}

export interface DeployerView {
    contracts: DeployedContract[];
    nextCursor: Hex | null;
}

export interface ModuleView {
    sourceCodeHash: Hex;
    module: Hex;
}

/**
 * Typed helpers for the `contracts/1` profile. Code written against it
 * works for every runtime that implements it.
 */
export class ContractsProfile {
    readonly features: ContractFeatures;

    constructor(
        private readonly gateway: GatewayClient,
        readonly domainId: number,
        profile: ProfileInfo
    ) {
        const f = requireRecord<ProfileInfo["features"]>("zeno_chainInfo", profile.features, "the profile features");
        this.features = {
            upgrade: f.upgrade === true,
            ownershipTransfer: f.ownershipTransfer === true,
            storageQuota: f.storageQuota === true,
            payableCalls: f.payableCalls === true,
            deposits: f.deposits === true,
            nativeAddresses: f.nativeAddresses === true,
        };
        this.interfaceEncodings = profile.interfaceEncodings;
    }

    /** The `interfaceEncodings` the domain accepts. */
    readonly interfaceEncodings: string[];

    contract(contractId: Hex, tag?: Tag): Promise<Verified<ReadResult<ContractView>>> {
        return this.gateway.read<ContractView>(this.domainId, "contract", { contractId }, tag);
    }

    /** Reads one storage key. `key` is up to 32 bytes of hex. */
    storage(contractId: Hex, key: Hex, tag?: Tag) {
        return this.gateway.read<StorageView>(this.domainId, "storage", { contractId, key }, tag);
    }

    /** Lists the contracts an L1 address deployed, newest first. Index data: it carries no state proof. */
    contractsByDeployer(address: string, cursor?: Hex, tag?: Tag) {
        const params: Record<string, unknown> = { address };
        if (cursor !== undefined) params.cursor = cursor;
        return this.gateway.read<DeployerView>(this.domainId, "contractsByDeployer", params, tag);
    }

    /**
     * Fetches a deployed module by its as-deployed `sourceCodeHash` and
     * checks `SHA3-256(module)` against it.
     */
    async module(sourceCodeHash: Hex, tag?: Tag): Promise<{ sourceCodeHash: Hex; module: Uint8Array; batchId: number; verified: boolean }> {
        const read = await this.gateway.read<ModuleView>(this.domainId, "module", { sourceCodeHash }, tag);
        const result = requireRecord<ModuleView>("zeno_read", read.result);
        const bytes = hexToBytes(result.module, "the module", (detail) => new GatewayVerificationError("zeno_read", "module hash", detail));
        if (toHex(sha3(bytes)) !== sourceCodeHash.toLowerCase() || result.sourceCodeHash !== sourceCodeHash.toLowerCase()) {
            throw new GatewayVerificationError("zeno_read", "module hash", `the module does not hash to ${show(sourceCodeHash)}`);
        }
        return { sourceCodeHash: result.sourceCodeHash, module: bytes, batchId: read.batchId, verified: read.verified };
    }

    /** The `contractId` whose native form is `address`. Only when the domain sets `nativeAddresses`. */
    resolveNativeAddress(address: string, tag?: Tag) {
        this.requireNative();
        return this.gateway.read<{ contractId: Hex | null }>(this.domainId, "resolveNativeAddress", { address }, tag);
    }

    /** The canonical `caller` of an L1 address and its native form. Only when the domain sets `nativeAddresses`. */
    nativeCaller(l1Address: string, tag?: Tag) {
        this.requireNative();
        return this.gateway.read<{ caller: Hex; nativeAddress: string }>(this.domainId, "nativeCaller", { l1Address }, tag);
    }

    private requireNative(): void {
        if (!this.features.nativeAddresses) {
            throw new UnsupportedProfileError(`${CONTRACTS_PROFILE} nativeAddresses`, this.domainId);
        }
    }
}

/** Throws `UnsupportedProfileError` when the domain does not implement `contracts/1`. */
export async function contractsProfile(gateway: GatewayClient, domainId: number): Promise<ContractsProfile> {
    const info = await gateway.info(domainId);
    if (!Array.isArray(info.profiles)) {
        throw new GatewayVerificationError("zeno_chainInfo", "result structure", "profiles is not a list");
    }
    const profile = info.profiles.find((p) => requireRecord<ProfileInfo>("zeno_chainInfo", p, "a profile").name === CONTRACTS_PROFILE);
    if (!profile) throw new UnsupportedProfileError(CONTRACTS_PROFILE, domainId);
    return new ContractsProfile(gateway, domainId, profile);
}
