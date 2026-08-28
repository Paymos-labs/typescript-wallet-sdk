/**
 * Authenticated transport, ported from the Python SDK so both languages fail the same way.
 *
 * Attaches `Authorization: Bearer <api key>` to every request, returns parsed JSON on a 2xx, and
 * maps anything else onto a typed error through the server's envelope. The server's contract:
 * business errors are `{"error": "…"}` and the sign flow answers
 * `{"ok":false,"status":"failed","error":"…"}` — both carry the message under `error`. Those
 * messages arrive already client-safe, so this layer maps them and never rewrites them, and it
 * never logs or echoes a request body.
 *
 * Transport failures are wrapped into a typed error with no status, so a caller on the money path
 * never catches a raw fetch exception. The timeout is generous because the co-sign is a multi-round
 * exchange that outlasts anything a default would allow.
 */
import {
	AuthError,
	Conflict,
	CrossAssetWithdrawNotAllowed,
	Forbidden,
	InsufficientFunds,
	PaymosError,
	QuoteExpired,
	RateLimited,
	RouteUnavailable,
	SlippageExceeded
} from './errors.js';

/** The sign/aggregate round can trigger a relay that takes a while. */
const DEFAULT_TIMEOUT_MS = 60_000;

function messageOf(body: unknown, status: number, text: string): string {
	if (body && typeof body === 'object') {
		const o = body as Record<string, unknown>;
		const msg = o.error ?? o.detail;
		if (typeof msg === 'string' && msg) return msg;
	}
	return text.trim() || `request failed with status ${status}`;
}

/** Map a 400's message to a type. First match wins, in this exact order. */
function classify400(message: string): new (m: string, s?: number) => PaymosError {
	const m = message.toLowerCase();
	if (m.includes('cross-asset')) return CrossAssetWithdrawNotAllowed;
	if (m.includes('slippage')) return SlippageExceeded;
	if (m.includes('expired')) return QuoteExpired;
	for (const t of ['insufficient', 'not enough balance', 'exceeds the vault', 'available balance']) {
		if (m.includes(t)) return InsufficientFunds;
	}
	// The server's route and liquidity rejections come back sounding transient — "No liquidity
	// available … try again in a moment", "route can't be quoted". That whole family is one type.
	for (const t of ['route', "can't be quoted", 'liquidity', 'try again in a moment']) {
		if (m.includes(t)) return RouteUnavailable;
	}
	return PaymosError;
}

function raiseFor(status: number, body: unknown, text: string, retryAfterHeader: string | null): never {
	const message = messageOf(body, status, text);
	if (status === 401) throw new AuthError(message, status);
	if (status === 403) throw new Forbidden(message, status);
	if (status === 409) throw new Conflict(message, status);
	if (status === 429) {
		const parsed = retryAfterHeader === null ? Number.NaN : Number.parseInt(retryAfterHeader, 10);
		throw new RateLimited(message, status, Number.isInteger(parsed) ? parsed : undefined);
	}
	if (status === 400) throw new (classify400(message))(message, status);
	// 404 has no type of its own by design; it and every other non-2xx land on the base error.
	throw new PaymosError(message, status);
}

export interface HttpOptions {
	/** Milliseconds before a request is abandoned. Default 60s, for the multi-round co-sign. */
	timeoutMs?: number;
	/** Swappable for tests, which hand in a stub instead of reaching the network. */
	fetch?: typeof globalThis.fetch;
}

export class Http {
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly timeoutMs: number;
	private readonly doFetch: typeof globalThis.fetch;

	constructor(baseUrl: string, apiKey: string, options: HttpOptions = {}) {
		this.baseUrl = baseUrl.replace(/\/+$/, '');
		this.apiKey = apiKey;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.doFetch = options.fetch ?? globalThis.fetch;
	}

	private headers(extra?: Record<string, string>): Record<string, string> {
		return { authorization: `Bearer ${this.apiKey}`, ...(extra ?? {}) };
	}

	private async send(path: string, init: RequestInit): Promise<unknown> {
		const url = `${this.baseUrl}${path}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		let response: Response;
		try {
			response = await this.doFetch(url, { ...init, signal: controller.signal });
		} catch (e) {
			throw new PaymosError(`transport error: ${(e as Error).message}`);
		} finally {
			clearTimeout(timer);
		}

		const text = await response.text();
		let body: unknown = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = null;
		}
		if (response.status >= 200 && response.status < 300) return body;
		raiseFor(response.status, body, text, response.headers.get('retry-after'));
	}

	async get(path: string, params?: Record<string, string | number | undefined>): Promise<unknown> {
		const query = new URLSearchParams();
		for (const [k, v] of Object.entries(params ?? {})) {
			if (v !== undefined) query.set(k, String(v));
		}
		const qs = query.toString();
		return this.send(`${path}${qs ? `?${qs}` : ''}`, { method: 'GET', headers: this.headers() });
	}

	async post(path: string, jsonBody: unknown, extraHeaders?: Record<string, string>): Promise<unknown> {
		return this.send(path, {
			method: 'POST',
			headers: this.headers({ 'content-type': 'application/json', ...(extraHeaders ?? {}) }),
			body: JSON.stringify(jsonBody)
		});
	}
}
