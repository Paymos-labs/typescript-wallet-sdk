/**
 * The read model, ported field-for-field from the Python SDK.
 *
 * Every amount is a STRING of raw integer units, never a number. A token with 18 decimals runs past
 * what an IEEE double holds exactly, so a JSON parser that produced numbers here would round
 * somebody's balance without saying so. Use `formatUnits` to show one and `parseUnits` to build one.
 */
import { PaymosError } from './errors.js';

/** One asset the vault can hold, as the server names it. */
export interface Asset {
	readonly asset: string;
	readonly symbol: string;
	readonly chain: string;
	readonly decimals: number;
	/**
	 * Lowercase hex SHA-256 of the asset's raw on-chain id. The co-sign guard hashes the token each
	 * disclosed transfer moves and refuses unless it matches the send asset's fingerprint. It is the
	 * server's own statement; pin it with `pinnedFingerprints` for an anchor independent of the
	 * server. Null from a server too old to publish one — reads still work; a co-sign does not.
	 */
	readonly fingerprint: string | null;
}

/** What the vault holds of one asset. `usd` is a display estimate and may be absent. */
export interface Balance {
	readonly asset: string;
	readonly symbol: string;
	readonly chain: string;
	readonly decimals: number;
	readonly amountRaw: string;
	readonly usd: string | null;
}

/** The routing layer's own fee. `estimate` marks a figure that can still move. */
export interface RouteFee {
	readonly amount: string;
	readonly estimate: boolean;
}

/** Every charge on an operation, split so none of them can hide inside another. */
export interface Fees {
	readonly asset: string;
	readonly platform: string;
	readonly network: string;
	readonly route: RouteFee | null;
	readonly total: string;
	readonly usd: Readonly<Record<string, string | null>> | null;
}

export interface Amount {
	readonly amount: string;
	readonly asset: string;
}

/** What arrives. `min` is the floor the quote promises to deliver; `minReceive` on `swap` refuses to sign below yours. */
export interface Receive {
	readonly amount: string;
	readonly min: string;
	readonly asset: string;
}

export interface Quote {
	readonly movementId: string | null;
	readonly mode: string;
	readonly send: Amount;
	/**
	 * The MAXIMUM this quote may take from the vault, reserve against slippage included — a ceiling,
	 * not a prediction. Approve against this and nothing can debit more than you agreed to; an
	 * exact-output route routinely spends less and returns the difference. Compare the finished
	 * movement's `send` to see what it actually cost.
	 */
	readonly debit: Amount;
	readonly receive: Receive;
	readonly fees: Fees;
	readonly expiresAt: string;
	readonly sources: number | null;
}

export interface Movement {
	readonly id: string;
	readonly type: string;
	readonly status: string;
	/**
	 * What the movement actually cost the vault: the approved maximum minus anything the route handed
	 * back. This is the figure that matches the on-chain balance — reconcile on it. It is NOT the
	 * quote's `debit`, which is the ceiling that was approved before the route ran.
	 */
	readonly send: Amount;
	readonly receive: Receive;
	readonly fees: Fees | null;
	readonly destChainTxHash: string | null;
	readonly destChainExplorerUrl: string | null;
	readonly createdAt: string;
	readonly completedAt: string | null;
}

// ── Wire → model ────────────────────────────────────────────────────────────
//
// The server speaks snake_case and the SDK hands back camelCase, so the mapping happens once, here,
// rather than at every call site. The server OMITS a null field rather than sending `null`, so an
// optional one is read as absent-or-null and becomes null. A REQUIRED one that is missing is contract
// drift, and it fails here as a PaymosError — the old behaviour, an empty string, reached BigInt as 0
// and let a malformed quote read as a free one.

type Wire = Record<string, unknown>;

const rec = (v: unknown, what: string): Wire => {
	if (v === null || typeof v !== 'object' || Array.isArray(v)) {
		throw new PaymosError(`malformed response: ${what} is not an object`);
	}
	return v as Wire;
};
const req = (o: Wire, key: string, what: string): unknown => {
	const v = o[key];
	if (v == null) throw new PaymosError(`malformed response: ${what} has no ${key}`);
	return v;
};
const str = (o: Wire, key: string, what: string): string => String(req(o, key, what));
const int = (o: Wire, key: string, what: string): number => {
	const n = Number(req(o, key, what));
	if (!Number.isInteger(n)) throw new PaymosError(`malformed response: ${what}.${key} is not an integer`);
	return n;
};
const orNull = (v: unknown): string | null => (v == null ? null : String(v));

export const toAsset = (w: unknown): Asset => {
	const o = rec(w, 'asset');
	return {
		asset: str(o, 'asset', 'asset'),
		symbol: str(o, 'symbol', 'asset'),
		chain: str(o, 'chain', 'asset'),
		decimals: int(o, 'decimals', 'asset'),
		fingerprint: o.fingerprint == null ? null : String(o.fingerprint).toLowerCase()
	};
};

export const toBalance = (w: unknown): Balance => {
	const o = rec(w, 'balance');
	return {
		asset: str(o, 'asset', 'balance'),
		symbol: str(o, 'symbol', 'balance'),
		chain: str(o, 'chain', 'balance'),
		decimals: int(o, 'decimals', 'balance'),
		amountRaw: str(o, 'amount_raw', 'balance'),
		usd: orNull(o.usd)
	};
};

const toRouteFee = (w: unknown): RouteFee | null => {
	if (w == null) return null;
	const o = rec(w, 'fees.route');
	return { amount: str(o, 'amount', 'fees.route'), estimate: Boolean(o.estimate) };
};

export const toFees = (w: unknown): Fees | null => {
	if (w == null) return null;
	const o = rec(w, 'fees');
	const usd = o.usd == null ? null : rec(o.usd, 'fees.usd');
	return {
		asset: str(o, 'asset', 'fees'),
		platform: str(o, 'platform', 'fees'),
		network: str(o, 'network', 'fees'),
		route: toRouteFee(o.route),
		total: str(o, 'total', 'fees'),
		usd: usd === null ? null : Object.fromEntries(Object.entries(usd).map(([k, v]) => [k, orNull(v)]))
	};
};

const toAmount = (w: unknown, what: string): Amount => {
	const o = rec(w, what);
	return { amount: str(o, 'amount', what), asset: str(o, 'asset', what) };
};

const toReceive = (w: unknown, what: string): Receive => {
	const o = rec(w, what);
	return { amount: str(o, 'amount', what), min: str(o, 'min', what), asset: str(o, 'asset', what) };
};

export const toQuote = (w: unknown): Quote => {
	const o = rec(w, 'quote');
	const sources = o.sources;
	if (sources != null && !Number.isInteger(Number(sources))) {
		throw new PaymosError('malformed response: quote.sources is not an integer');
	}
	return {
		movementId: orNull(o.movement_id),
		mode: str(o, 'mode', 'quote'),
		send: toAmount(req(o, 'send', 'quote'), 'quote.send'),
		debit: toAmount(req(o, 'debit', 'quote'), 'quote.debit'),
		receive: toReceive(req(o, 'receive', 'quote'), 'quote.receive'),
		fees: toFees(req(o, 'fees', 'quote')) as Fees,
		expiresAt: str(o, 'expires_at', 'quote'),
		// Omitted on a dry preview: there is nothing to sign.
		sources: sources == null ? null : Number(sources)
	};
};

export const toMovement = (w: unknown): Movement => {
	const o = rec(w, 'movement');
	return {
		id: str(o, 'id', 'movement'),
		type: str(o, 'type', 'movement'),
		status: str(o, 'status', 'movement'),
		send: toAmount(req(o, 'send', 'movement'), 'movement.send'),
		receive: toReceive(req(o, 'receive', 'movement'), 'movement.receive'),
		// A list row carries no fee legs; only the single-movement detail does.
		fees: toFees(o.fees),
		destChainTxHash: orNull(o.dest_chain_tx_hash),
		destChainExplorerUrl: orNull(o.dest_chain_explorer_url),
		createdAt: str(o, 'created_at', 'movement'),
		completedAt: orNull(o.completed_at)
	};
};
