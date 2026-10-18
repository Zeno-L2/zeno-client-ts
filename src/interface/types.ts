import type { Hex } from "../gateway/types.js";

/** One named, typed value. `type` uses the shared vocabulary of `value.ts`. */
export interface Param {
    name: string;
    type: string;
}

export interface EventField extends Param {
    /** An indexed field travels in a topic after the event's own topic, not in the data. */
    indexed: boolean;
}

export interface MethodDef {
    name: string;
    /** The first four bytes of `SHA3-256(name)`, 4 bytes of hex. */
    selector: Hex;
    payable: boolean;
    /** The method only reads and returns data, so a client calls it through `simulate`. */
    readonly: boolean;
    inputs: Param[];
    /** The named values the method returns, in order. Empty when it returns nothing. */
    outputs: Param[];
    description?: string;
}

/** The method that receives a bare deposit. */
export interface DepositHandlerDef {
    name: string;
    outputs: Param[];
}

export interface EventDef {
    name: string;
    /** The first topic that marks this event: `SHA3-256(name)`, 32 bytes of hex. */
    topic: Hex;
    fields: EventField[];
    description?: string;
}

export interface ErrorDef {
    /** A contract code above zero, or an SDK failure code below zero. */
    code: number;
    name: string;
    fields: Param[];
    description: string;
}

export interface StorageDef {
    name: string;
    kind: "item" | "map";
    /** The namespace byte as `0x` and two hex digits, `0x01` to `0xff`. */
    namespace: string;
    /** The key fields of a map. Empty for an item. */
    key: Param[];
    /** True when the local key is `SHA3-256` of the key bytes. */
    hashed: boolean;
    value: string;
    description?: string;
}

/**
 * A runtime-neutral contract interface: what a client needs to render
 * and encode calls without knowing the runtime.
 */
export interface ContractInterface {
    interface_version: 1;
    /** An `interfaceEncodings` value of the domain, for example `zeno-selector-v1`. */
    encoding: string;
    /** `SHA3-256` of the module as deployed, 32 bytes of hex. */
    code_hash: Hex;
    methods: MethodDef[];
    /** The deposit handler, or null when the contract takes no bare deposits. */
    on_deposit: DepositHandlerDef | null;
    events: EventDef[];
    errors: ErrorDef[];
    storage: StorageDef[];
}

export type Value = bigint | number | boolean | string | Uint8Array | Value[];

export interface DecodedEvent {
    name: string;
    fields: Record<string, Value>;
}

export interface DecodedError {
    code: number;
    /** The error's name, or a description of an SDK failure (a code below zero). */
    name: string;
    fields: Record<string, Value>;
}

/** Encodes and decodes contract payloads for one `interfaceEncodings` entry. */
export interface InterfaceEncoder {
    encoding: string;
    /** The `callL2` payload for `method` with `args` in declared order. */
    encodeCall(iface: ContractInterface, method: string, args: Value[]): Uint8Array;
    /** The method's outputs by name. Empty when it returns nothing. */
    decodeReturn(iface: ContractInterface, method: string, returnData: Uint8Array): Record<string, Value>;
    /** Names a `REVERT`'s `abortCode` and decodes its fields from the revert data. */
    decodeError(iface: ContractInterface, abortCode: number, revertData: Uint8Array): DecodedError;
    /** Identifies an event by its first topic and decodes its data. Returns null for an unknown event. */
    decodeEvent(iface: ContractInterface, topics: Hex[], data: Uint8Array): DecodedEvent | null;
    /** The `localKey` of a storage item or map entry, ready for the `storage` view. */
    storageKey(iface: ContractInterface, name: string, key?: Value[]): Uint8Array;
    /** Decodes a stored value of an item or map. */
    decodeStorageValue(iface: ContractInterface, name: string, value: Uint8Array): Value;
}
