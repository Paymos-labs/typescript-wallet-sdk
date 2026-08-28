/**
 * Typed errors, ported one-for-one from the Python SDK so a caller who knows one knows the other.
 *
 * Every read, quote and sign call routes through `http.ts`, which turns the server's error envelope
 * into one of these. `message` is the server's already client-safe reason; `status` is the HTTP code
 * that produced it, or undefined when the error did not come from a response.
 *
 * The set is fixed by the SDK spec — deliberately no `NotFound`, since a 404 surfaces as the base
 * `PaymosError`. Nothing here re-parses or rewrites a server message.
 */

export class PaymosError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		// Without this, `instanceof` breaks for subclasses when the package is compiled to ES5 —
		// a caller branching on the error type is the whole reason these classes exist.
		Object.setPrototypeOf(this, new.target.prototype);
		this.name = new.target.name;
		this.status = status;
	}
}

/** 401 — the API key is missing, malformed, or not recognised. */
export class AuthError extends PaymosError {}

/** 403 — the key is valid but lacks the scope this call requires. */
export class Forbidden extends PaymosError {}

/** 400 — the vault's available balance cannot cover the amount plus fees. */
export class InsufficientFunds extends PaymosError {}

/** 400 — the referenced quote has expired; fetch a fresh one and retry. */
export class QuoteExpired extends PaymosError {}

/** 400 — the delivered amount fell outside the accepted slippage bound. */
export class SlippageExceeded extends PaymosError {}

/** 400 — a withdraw changed the asset; that is a swap, and it is rejected here. */
export class CrossAssetWithdrawNotAllowed extends PaymosError {}

/** 400 — no route could be quoted for this pair right now; retry shortly. */
export class RouteUnavailable extends PaymosError {}

/** 429 — too many requests. `retryAfter` is the Retry-After header when the server sent one. */
export class RateLimited extends PaymosError {
	readonly retryAfter?: number;

	constructor(message: string, status?: number, retryAfter?: number) {
		super(message, status);
		this.retryAfter = retryAfter;
	}
}

/** 409 — idempotency-key conflict: reused with a different request, or a quote is still forming. */
export class Conflict extends PaymosError {}
