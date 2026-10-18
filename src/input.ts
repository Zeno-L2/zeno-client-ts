import { sha3_256 } from "@noble/hashes/sha3";
import { concat } from "./bytes.js";
import { Address, Hash } from "znn-typescript-sdk";
import { ZenoWriter } from "./codec.js";
import { InputKind } from "./constants.js";

interface Deposit {
    depositAsset: Hash;
    depositAmount: bigint;
}

export type CanonicalInput =
    | ({ kind: typeof InputKind.CALL_L2; targetContract: Hash; plasmaLimit: bigint; payload: Uint8Array } & Deposit)
    | ({ kind: typeof InputKind.DEPOSIT; targetContract: Hash; plasmaLimit: bigint } & Deposit)
    | {
          kind: typeof InputKind.DEPLOY_CONTRACT_START;
          codeHash: Hash;
          metadataHash: Hash;
          totalSize: bigint;
          chunkCount: number;
          metadata: Uint8Array;
      }
    | { kind: typeof InputKind.DEPLOY_CONTRACT_CHUNK; codeHash: Hash; chunkIndex: number; chunkHash: Hash }
    | { kind: typeof InputKind.DEPLOY_CONTRACT_FINALIZE; codeHash: Hash }
    | { kind: typeof InputKind.UPGRADE_CONTRACT; contractId: Hash; newCodeHash: Hash }
    | { kind: typeof InputKind.TRANSFER_CONTRACT_OWNERSHIP; contractId: Hash; newOwner: Address }
    | { kind: typeof InputKind.BUY_STORAGE; contractId: Hash; bytes: bigint };

/**
 * The canonical input encoding of SPEC §27.5:
 * `input_kind || source_account_block_hash || kind-specific tail`.
 * It is the `inputHash` preimage and the `inputRoot` leaf.
 */
export function encodeInput(sourceAccountBlockHash: Hash, input: CanonicalInput): Uint8Array {
    const w = new ZenoWriter().u8(input.kind).bytes32(sourceAccountBlockHash.getBytes());

    switch (input.kind) {
        case InputKind.CALL_L2:
            w.bytes32(input.targetContract.getBytes()).u64(input.plasmaLimit)
                .bytes32(input.depositAsset.getBytes()).u256(input.depositAmount).bytes(input.payload);
            break;
        case InputKind.DEPOSIT:
            w.bytes32(input.targetContract.getBytes()).u64(input.plasmaLimit)
                .bytes32(input.depositAsset.getBytes()).u256(input.depositAmount);
            break;
        case InputKind.DEPLOY_CONTRACT_START:
            w.bytes32(input.codeHash.getBytes()).bytes32(input.metadataHash.getBytes())
                .u64(input.totalSize).u32(input.chunkCount).bytes(input.metadata);
            break;
        case InputKind.DEPLOY_CONTRACT_CHUNK:
            w.bytes32(input.codeHash.getBytes()).u32(input.chunkIndex).bytes32(input.chunkHash.getBytes());
            break;
        case InputKind.DEPLOY_CONTRACT_FINALIZE:
            w.bytes32(input.codeHash.getBytes());
            break;
        case InputKind.UPGRADE_CONTRACT:
            w.bytes32(input.contractId.getBytes()).bytes32(input.newCodeHash.getBytes());
            break;
        case InputKind.TRANSFER_CONTRACT_OWNERSHIP:
            w.bytes32(input.contractId.getBytes()).address(input.newOwner.getBytes());
            break;
        case InputKind.BUY_STORAGE:
            w.bytes32(input.contractId.getBytes()).u64(input.bytes);
            break;
    }
    return w.finish();
}

/** `inputHash = SHA3-256(canonical input encoding)`. */
export function inputHash(sourceAccountBlockHash: Hash, input: CanonicalInput): Hash {
    return new Hash(Buffer.from(sha3_256(encodeInput(sourceAccountBlockHash, input))));
}

/**
 * The binary Merkle root of SPEC §27.3: leaf `SHA3-256(0x00 || element)`,
 * node `SHA3-256(0x01 || left || right)`, an odd last node promoted
 * unchanged, and `bytes32(0)` for the empty set.
 */
export function merkleRoot(elements: readonly Uint8Array[]): Hash {
    if (elements.length === 0) {
        return new Hash(Buffer.alloc(32));
    }
    let level = elements.map((e) => sha3_256(concat([Uint8Array.of(0x00), e])));
    while (level.length > 1) {
        const next: Uint8Array[] = [];
        for (let i = 0; i < level.length; i += 2) {
            next.push(
                i + 1 < level.length
                    ? sha3_256(concat([Uint8Array.of(0x01), level[i], level[i + 1]]))
                    : level[i]
            );
        }
        level = next;
    }
    return new Hash(Buffer.from(level[0]));
}

/** `inputRoot`: the Merkle root over canonical input encodings in `globalInputIndex` order. */
export function inputRoot(encodedInputs: readonly Uint8Array[]): Hash {
    return merkleRoot(encodedInputs);
}
