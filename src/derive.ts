import { sha3_256 } from "@noble/hashes/sha3";
import { concat } from "./bytes.js";
import { show } from "./format.js";
import { Address, Hash, settlement } from "znn-typescript-sdk";
import { ZenoCodecError, ZenoReader, ZenoWriter } from "./codec.js";

const { UpgradePolicy } = settlement;

const utf8 = (text: string) => new TextEncoder().encode(text);

export function sha3(...parts: Uint8Array[]): Uint8Array {
    return sha3_256(concat(parts));
}

/** `chain_id = SHA3-256("ZENON_WASM_L2:" || network_name)` (SPEC §9.1). */
export function chainId(networkName: string): Hash {
    return new Hash(Buffer.from(sha3(utf8("ZENON_WASM_L2:"), utf8(networkName))));
}

/** `caller = SHA3-256("L1_CALLER:" || raw_l1_address)` (SPEC §9.2). */
export function l1Caller(address: Address): Hash {
    return new Hash(Buffer.from(sha3(utf8("L1_CALLER:"), address.getBytes())));
}

/** `ContractID = SHA3-256(deployer(20B) || globalInputIndex(8B BE) || chain_id)` (SPEC §12). */
export function contractId(deployer: Address, globalInputIndex: bigint, chain: Hash): Hash {
    const index = new ZenoWriter().u64(globalInputIndex).finish();
    return new Hash(Buffer.from(sha3(deployer.getBytes(), index, chain.getBytes())));
}

/** `smt_key = SHA3-256(contract_id || local_key)` (SPEC §13.3). */
export function smtKey(contract: Hash, localKey: Uint8Array): Hash {
    return new Hash(Buffer.from(sha3(contract.getBytes(), localKey)));
}

const METADATA_VERSION = 1;
const METADATA_SIZE = 23;

export interface ContractMetadata {
    upgradePolicy: number;
    owner: Address;
}

const isZero = (bytes: Uint8Array) => bytes.every((b) => b === 0);

function assertMetadata(policy: number, owner: Uint8Array): void {
    if (policy !== UpgradePolicy.IMMUTABLE && policy !== UpgradePolicy.OWNER_UPGRADEABLE) {
        throw new ZenoCodecError(`invalid upgrade policy ${show(policy)}`);
    }
    if (policy === UpgradePolicy.IMMUTABLE && !isZero(owner)) {
        throw new ZenoCodecError("an IMMUTABLE contract must have the zero owner");
    }
    if (policy === UpgradePolicy.OWNER_UPGRADEABLE && isZero(owner)) {
        throw new ZenoCodecError("an OWNER_UPGRADEABLE contract must have a non-zero owner");
    }
}

/** The 23-byte version-1 `ContractMetadata` (SPEC §27.12). */
export function encodeMetadata(metadata: ContractMetadata): Uint8Array {
    const owner = metadata.owner.getBytes();
    assertMetadata(metadata.upgradePolicy, owner);
    return new ZenoWriter().u16(METADATA_VERSION).u8(metadata.upgradePolicy).address(owner).finish();
}

export function decodeMetadata(bytes: Uint8Array): ContractMetadata {
    if (bytes.length < METADATA_SIZE) {
        throw new ZenoCodecError("truncated ContractMetadata");
    }
    const reader = new ZenoReader(bytes);
    const version = reader.u16();
    if (version !== METADATA_VERSION) {
        throw new ZenoCodecError(`unknown ContractMetadata version ${show(version)}`);
    }
    const upgradePolicy = reader.u8();
    const owner = reader.address();
    reader.end();
    assertMetadata(upgradePolicy, owner);
    return { upgradePolicy, owner: Address.fromCore(owner) };
}
