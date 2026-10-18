import { bounded, show } from "../format.js";

/** An error answered by the gateway, with its JSON-RPC code. */
export class GatewayError extends Error {
    constructor(
        message: string,
        public readonly code: number,
        public readonly method?: string,
        public readonly data?: unknown
    ) {
        super(message);
        this.name = new.target.name;
    }
}

export class UnknownDomainError extends GatewayError {}
/** The tag is not served: `pending` from a remote gateway, or state older than `finalized`. */
export class TagUnavailableError extends GatewayError {}
export class DomainInconsistentError extends GatewayError {}
export class NotFoundError extends GatewayError {}
export class UnknownViewError extends GatewayError {}
export class SimulationUnavailableError extends GatewayError {}
export class InvalidParamsError extends GatewayError {}

/** The domain does not implement a profile the caller needs. */
export class UnsupportedProfileError extends Error {
    constructor(public readonly profile: string, public readonly domainId: number) {
        super(`domain ${show(domainId)} does not implement the ${show(profile)} profile`);
        this.name = "UnsupportedProfileError";
    }
}

/** No encoder is registered for an interface encoding. */
export class UnsupportedEncodingError extends Error {
    constructor(public readonly encoding: string) {
        super(`no interface encoder is registered for ${show(encoding)}`);
        this.name = "UnsupportedEncodingError";
    }
}

/** A proof or root check failed. `check` names the step that failed. */
export class GatewayVerificationError extends Error {
    constructor(public readonly method: string, public readonly check: string, detail?: string) {
        super(`${method}: ${check} failed${detail ? `: ${detail}` : ""}`);
        this.name = "GatewayVerificationError";
    }
}

/** A gateway response is larger than the response size limit. The transport stops reading once the limit is passed. */
export class ResponseSizeError extends GatewayVerificationError {
    constructor(method: string, public readonly limit: number) {
        super(method, "response size", `the response is larger than the limit of ${show(limit)} bytes`);
        this.name = "ResponseSizeError";
    }
}

const BY_CODE: Record<number, new (message: string, code: number, method?: string, data?: unknown) => GatewayError> = {
    [-32001]: UnknownDomainError,
    [-32002]: TagUnavailableError,
    [-32003]: DomainInconsistentError,
    [-32004]: NotFoundError,
    [-32005]: UnknownViewError,
    [-32006]: SimulationUnavailableError,
    [-32602]: InvalidParamsError,
};

/**
 * Maps a transport error carrying a JSON-RPC code to its typed error.
 * An error without a numeric code is a transport failure and passes
 * through unchanged.
 */
export function mapGatewayError(error: unknown, method: string): unknown {
    if (error instanceof GatewayError) return error;
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code !== "number") return error;
    const raw = (error as { message?: unknown }).message;
    const message = raw === undefined ? "gateway error" : bounded(String(raw));
    const data = (error as { data?: unknown }).data;
    const Type = BY_CODE[code] ?? GatewayError;
    return new Type(message, code, method, data);
}

/** The gateway connection broke the protocol or a transport limit: a malformed message, too many requests in flight, or a request that got no answer in time. */
export class GatewayProtocolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GatewayProtocolError";
    }
}
