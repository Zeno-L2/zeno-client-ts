import { settlement } from "znn-typescript-sdk";
import { ZenoCodecError } from "../codec.js";
import { show } from "../format.js";
import { sha3 } from "../derive.js";
import { interfaceEncoderFor } from "../runtime/registry.js";
import type { ContractInterface, Value } from "./types.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

export interface PrepareDeployOptions {
    /** The domain's `interfaceEncodings`. When given, the interface's encoding must be in it. */
    interfaceEncodings?: string[];
}

/**
 * Returns the bytes to pass to `settlement.planDeploy`: the module
 * itself. Checks `size <= MaxCodeSize` and, when an interface is given,
 * that its `code_hash` equals `SHA3-256(module)` and that its encoding
 * is one the domain accepts.
 */
export function prepareDeploy(
    module: Uint8Array,
    iface?: ContractInterface,
    options: PrepareDeployOptions = {}
): Uint8Array {
    if (module.length === 0) throw new ZenoCodecError("the module is empty");
    if (module.length > settlement.MaxCodeSize) {
        throw new ZenoCodecError(`the module is ${show(module.length)} bytes, above MaxCodeSize ${show(settlement.MaxCodeSize)}`);
    }
    if (!iface) return module;
    if (hex(sha3(module)) !== iface.code_hash.toLowerCase()) {
        throw new ZenoCodecError("the interface's code_hash is not SHA3-256 of the module");
    }
    if (options.interfaceEncodings && !options.interfaceEncodings.includes(iface.encoding)) {
        throw new ZenoCodecError(`the domain does not accept the ${show(iface.encoding)} encoding`);
    }
    return module;
}

/** Returns the payload for `settlement.callL2`, after checking `payload <= MaxCallPayload`. */
export function prepareCall(iface: ContractInterface, method: string, args: Value[]): Uint8Array {
    const payload = interfaceEncoderFor(iface.encoding).encodeCall(iface, method, args);
    if (payload.length > settlement.MaxCallPayload) {
        throw new ZenoCodecError(`the payload is ${show(payload.length)} bytes, above MaxCallPayload ${show(settlement.MaxCallPayload)}`);
    }
    return payload;
}
