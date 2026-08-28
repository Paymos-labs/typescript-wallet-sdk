/**
 * The read model, ported field-for-field from the Python SDK.
 *
 * Every amount is a STRING of raw integer units, never a number. A token with 18 decimals runs past
 * what an IEEE double holds exactly, so a JSON parser that produced numbers here would round
 * somebody's balance without saying so. Use `formatUnits` to show one and `parseUnits` to build one.
 */

/** One asset the vault can hold, as the server names it. */
export interface Asset {
	readonly asset: string;
	readonly symbol: string;
	readonly chain: string;
	readonly decimals: number;
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

/** What arrives. `min` is the floor the operation is allowed to deliver, and it is guaranteed. */
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
// rather than at every call site. A missing optional becomes null rather than undefined: `null` is
// what the server means and what JSON round-trips.

const rec = (v: unknown): Record<string, unknown> => (v ?? {}) as Record<string, unknown>;
const str = (v: unknown): string => String(v ?? '');
const orNull = (v: unknown): string | null => (v == null ? null : String(v));

export const toAsset = (w: unknown): Asset => {
	const o = rec(w);
	return { asset: str(o.asset), symbol: str(o.symbol), chain: str(o.chain), decimals: Number(o.decimals ?? 0) };
};

export const toBalance = (w: unknown): Balance => {
	const o = rec(w);
	return {
		asset: str(o.asset),
		symbol: str(o.symbol),
		chain: str(o.chain),
		decimals: Number(o.decimals ?? 0),
		amountRaw: str(o.amount_raw ?? o.amountRaw),
		usd: orNull(o.usd)
	};
};

const toRouteFee = (w: unknown): RouteFee | null => {
	if (w == null) return null;
	const o = rec(w);
	return { amount: str(o.amount), estimate: Boolean(o.estimate) };
};

export const toFees = (w: unknown): Fees | null => {
	if (w == null) return null;
	const o = rec(w);
	return {
		asset: str(o.asset),
		platform: str(o.platform),
		network: str(o.network),
		route: toRouteFee(o.route),
		total: str(o.total),
		usd: (o.usd ?? null) as Fees['usd']
	};
};

const toAmount = (w: unknown): Amount => {
	const o = rec(w);
	return { amount: str(o.amount), asset: str(o.asset) };
};

const toReceive = (w: unknown): Receive => {
	const o = rec(w);
	return { amount: str(o.amount), min: str(o.min), asset: str(o.asset) };
};

export const toQuote = (w: unknown): Quote => {
	const o = rec(w);
	return {
		movementId: orNull(o.movement_id ?? o.movementId),
		mode: str(o.mode),
		send: toAmount(o.send),
		debit: toAmount(o.debit),
		receive: toReceive(o.receive),
		fees: toFees(o.fees) as Fees,
		expiresAt: str(o.expires_at ?? o.expiresAt),
		sources: o.sources == null ? null : Number(o.sources)
	};
};

export const toMovement = (w: unknown): Movement => {
	const o = rec(w);
	return {
		id: str(o.id),
		type: str(o.type),
		status: str(o.status),
		send: toAmount(o.send),
		receive: toReceive(o.receive),
		fees: toFees(o.fees),
		destChainTxHash: orNull(o.dest_chain_tx_hash ?? o.destChainTxHash),
		destChainExplorerUrl: orNull(o.dest_chain_explorer_url ?? o.destChainExplorerUrl),
		createdAt: str(o.created_at ?? o.createdAt),
		completedAt: orNull(o.completed_at ?? o.completedAt)
	};
};
