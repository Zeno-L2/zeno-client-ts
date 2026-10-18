import { UnsupportedEncodingError } from "../gateway/errors.js";
import type { ReadResult } from "../gateway/types.js";
import type { ProvenLeaf } from "../gateway/verify.js";
import { zenoSelectorV1 } from "../interface/selector.js";
import type { InterfaceEncoder } from "../interface/types.js";
import { wasmPathDerivation } from "./wasm.js";

/**
 * Knows where a runtime keeps a view's state, so the client can check
 * that each proven path belongs to the request and re-derive the result
 * from the proven values.
 */
export interface PathDerivation {
    runtimeKind: string;
    /**
     * Returns true when it checked the view, false when the view is not
     * state-backed for this runtime. Throws `GatewayVerificationError`
     * on a mismatch.
     */
    verifyView(view: string, params: Record<string, unknown>, read: ReadResult, leaves: ProvenLeaf[]): boolean;
}

const derivations = new Map<string, PathDerivation>([[wasmPathDerivation.runtimeKind, wasmPathDerivation]]);
const encoders = new Map<string, InterfaceEncoder>([[zenoSelectorV1.encoding, zenoSelectorV1]]);

export function registerPathDerivation(derivation: PathDerivation): void {
    derivations.set(derivation.runtimeKind, derivation);
}

export function pathDerivationFor(runtimeKind: string | null): PathDerivation | undefined {
    return runtimeKind ? derivations.get(runtimeKind) : undefined;
}

export function registerInterfaceEncoder(encoder: InterfaceEncoder): void {
    encoders.set(encoder.encoding, encoder);
}

/** Throws `UnsupportedEncodingError` when no encoder is registered. */
export function interfaceEncoderFor(encoding: string): InterfaceEncoder {
    const encoder = encoders.get(encoding);
    if (!encoder) throw new UnsupportedEncodingError(encoding);
    return encoder;
}

export type { InterfaceEncoder };
