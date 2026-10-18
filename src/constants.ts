// Input kinds of SPEC §27.5.
export const InputKind = {
    CALL_L2: 0,
    DEPOSIT: 1,
    DEPLOY_CONTRACT_START: 2,
    DEPLOY_CONTRACT_CHUNK: 3,
    DEPLOY_CONTRACT_FINALIZE: 4,
    UPGRADE_CONTRACT: 5,
    TRANSFER_CONTRACT_OWNERSHIP: 6,
    BUY_STORAGE: 7,
} as const;

// Receipt status codes of SPEC §15.
export const ReceiptStatus = {
    SUCCESS: 0,
    REVERT: 1,
    OUT_OF_GAS: 2,
    RUNTIME_FAULT: 3,
    VALIDATION_FAILED: 4,
    RESULT_TOO_LARGE: 5,
    UNAUTHORIZED: 6,
    UNSUPPORTED_OPERATION: 7,
    STORAGE_QUOTA_EXCEEDED: 8,
} as const;

// Codec bounds used when decoding wire structures (SPEC §25.1).
export const MaxReturnData = 1024 * 4;
export const MaxExecutionResult = 1024 * 32;
export const MaxStateValueSize = 1024 * 16;
export const MaxEventsPerExecution = 64;
export const MaxEventDataSize = 1024;
export const MaxTopicsPerEvent = 4;
export const MaxOutboxPerExecution = 32;
export const MaxOutboxPayloadSize = 1024 * 8;
