/**
 * The entry point, ported from the Python SDK. Same methods, same checks, same refusals.
 *
 * Everything that moves money goes through a 2-of-2 co-sign in which this process holds one half of
 * the key and never sends it anywhere. The server cannot sign alone and neither can this — which is
 * only worth anything if this side refuses to sign things it has not checked, so it does:
 *
 *   the quote must echo what was approved   — a decimals bug or a lying server changes the numbers,
 *                                             and the numbers are compared before a commitment
 *   the debit may be capped                 — for an exact_out payout the input side is computed by
 *                                             the server, so `maxDebit` is the caller's ceiling; set
 *                                             it for any unattended payout
 *   never blind-sign                        — the server discloses each message, this side recomputes
 *                                             the digest and refuses unless the package binds to it,
 *                                             is from this vault, within the approved debit, and moves
 *                                             a token whose hash matches the send asset's fingerprint
 *
 * Any of those failing raises before a single signature share exists. What these checks do NOT
 * cover: the transfer's recipient is the route's deposit address, chosen by the server, and is not
 * checked here; "within the approved debit" is only as tight as that debit, which for exact_out is
 * the server's number unless `maxDebit` caps it; and the token fingerprint is the server's own
 * statement unless pinned (`pinnedFingerprints`).
 */
import { createHash } from 'node:crypto';
import { parseUnits } from './amounts.js';
import { payloadDigestHex } from './digest.js';
import { PaymosError, SlippageExceeded } from './errors.js';
import { Http, type HttpOptions } from './http.js';
import { commit as frostCommit, sign as frostSign } from './mpc.js';
import { INSPECT, mask, VaultSecret } from './secret.js';
import { parseStrict } from './strict-json.js';
import {
	toAsset,
	toBalance,
	toMovement,
	toQuote,
	type Asset,
	type Balance,
	type Movement,
	type Quote
} from './types.js';

type Json = Record<string, unknown>;

/**
 * A movement in any of these states has already been signed; a retry must not sign again. These are
 * the words the server actually sends (sdk/contract/fixtures/vocabulary.json) and exactly Python's
 * `_PROGRESSED_STATUSES`. `failed` is deliberately absent: a failed movement is not a signed one, and
 * treating it as "already done" returned success to a caller whose money never moved.
 */
export const PROGRESSED: ReadonlySet<string> = new Set(['processing', 'completed', 'refunded']);

/** A movement is settled (no more polling) once it reaches one of these. Python's `_TERMINAL_STATUSES`. */
export const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'refunded', 'expired', 'cancelled']);

/** Strict: `parseInt` would read "1g" as 1 and "zz" as NaN→0, and a nonce must be exactly what was disclosed. */
const hexToBytes = (hex: string): Uint8Array => {
	if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new PaymosError(`not hex: ${hex.length} chars`);
	return new Uint8Array(Buffer.from(hex, 'hex'));
};

/** A raw integer amount from the server, as a BigInt — a malformed one is a typed error, not a SyntaxError. */
const big = (raw: string, what: string): bigint => {
	if (!/^\d+$/.test(raw)) throw new PaymosError(`malformed response: ${what} is not a raw integer: ${JSON.stringify(raw)}`);
	return BigInt(raw);
};

const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

export interface WalletOptions extends HttpOptions {
	baseUrl?: string;
	/**
	 * Asset label → fingerprint (or several), fixed by you rather than read from the server. The
	 * co-sign guard checks every disclosed token against the send asset's fingerprint; by default
	 * that fingerprint comes from GET /assets — the same server that builds the messages — so the
	 * check catches a server bug or a compromised signing path, not a server that lies about both.
	 * A label pinned here is checked against ONLY the pinned value(s), whatever /assets says; an
	 * unpinned label uses what the server publishes. Values are compared lowercase.
	 */
	pinnedFingerprints?: Readonly<Record<string, string | readonly string[]>>;
}

/** Validates and lowercases `pinnedFingerprints` once, so a typo fails at construction, not mid-payout. */
function normalisePins(pins: WalletOptions['pinnedFingerprints']): Map<string, ReadonlySet<string>> {
	const out = new Map<string, ReadonlySet<string>>();
	for (const [label, value] of Object.entries(pins ?? {})) {
		const list = typeof value === 'string' ? [value] : value;
		if (!Array.isArray(list) || list.length === 0 || !list.every((v) => typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v))) {
			throw new PaymosError(`pinnedFingerprints[${label}] must be one or more 64-char hex sha-256 fingerprints`);
		}
		out.set(label, new Set(list.map((v) => v.toLowerCase())));
	}
	return out;
}

export class Wallet {
	// ES private fields, not TypeScript `private`: `console.log(wallet)`, `util.inspect`,
	// `JSON.stringify`, `Object.entries` and a spread all walk an object's own properties, and these
	// two hold the API key and the co-signing share. A # field is not a property at all.
	readonly #secret: VaultSecret;
	readonly #http: Http;
	private readonly pins: Map<string, ReadonlySet<string>>;
	private assetList: Asset[] | null = null;
	private assetCache: Map<string, Asset> | null = null;

	constructor(secret: string, options: WalletOptions = {}) {
		this.#secret = VaultSecret.parse(secret);
		// `||`, not `??`: an exported-but-empty PAYMOS_BASE_URL must not turn every URL into a bare path.
		const baseUrl = options.baseUrl || process.env.PAYMOS_BASE_URL || 'https://wallet.paymos.io';
		this.#http = new Http(baseUrl, this.#secret.apiKey, options);
		this.pins = normalisePins(options.pinnedFingerprints);
	}

	/** A stray `console.log(wallet)` or `JSON.stringify(wallet)` shows which vault — never its key or share. */
	toJSON(): Record<string, unknown> {
		return { vaultId: this.#secret.vaultId, hasShare: this.#secret.hasShare, http: this.#http.toJSON() };
	}

	[INSPECT](): string {
		return `Wallet(vaultId=${this.#secret.vaultId}, hasShare=${this.#secret.hasShare}, apiKey=${mask(this.#secret.apiKey)})`;
	}

	/** Reads `PAYMOS_VAULT_SECRET`, the way a deployed process is configured. */
	static fromEnv(options: WalletOptions = {}): Wallet {
		const secret = process.env.PAYMOS_VAULT_SECRET;
		if (!secret) throw new PaymosError('PAYMOS_VAULT_SECRET is not set');
		return new Wallet(secret, options);
	}

	// ── reads ────────────────────────────────────────────────────────────────

	/**
	 * The asset catalogue. The server answers a BARE JSON array. This used to read `body.assets`,
	 * which never existed: it returned [] on every call, and every quote, swap and withdraw then
	 * failed with "unknown asset". Anything other than an array is refused, never read as empty.
	 */
	async assets(): Promise<Asset[]> {
		return expectArray(await this.#http.get('/vault/v1/assets'), '/assets').map(toAsset);
	}

	/** The vault's balances — a bare JSON array, like `assets()`. */
	async balances(): Promise<Balance[]> {
		return expectArray(await this.#http.get('/vault/v1/balances'), '/balances').map(toBalance);
	}

	async movement(movementId: string): Promise<Movement> {
		return toMovement(await this.#http.get(`/vault/v1/movements/${encodeURIComponent(movementId)}`));
	}

	/**
	 * A page of the caller's movement history (newest first, summary rows without fee legs) and
	 * the next cursor; pass it back as `cursor` for the next page (null when exhausted). The
	 * server speaks keyset pagination: `items` + `next_cursor`.
	 */
	async movements(limit = 50, cursor?: string): Promise<{ items: Movement[]; nextCursor: string | null }> {
		const body = expectObject(await this.#http.get('/vault/v1/movements', { limit, cursor }), '/movements');
		const items = expectArray(body.items, '/movements items').map(toMovement);
		const nextCursor = body.next_cursor == null ? null : String(body.next_cursor);
		return { items, nextCursor };
	}

	/**
	 * Polls until the movement reaches a terminal status —
	 * `completed | failed | refunded | expired | cancelled`.
	 */
	async wait(movementId: string, { timeoutMs = 300_000, intervalMs = 2_000 } = {}): Promise<Movement> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const mv = await this.movement(movementId);
			if (TERMINAL.has(mv.status)) return mv;
			if (Date.now() >= deadline) throw new PaymosError(`timed out waiting for movement ${movementId}`);
			await new Promise((r) => setTimeout(r, intervalMs));
		}
	}

	// ── quotes ───────────────────────────────────────────────────────────────

	/**
	 * A dry preview. Nothing is created and nothing is signed.
	 *
	 * `amount` is a HUMAN decimal string in the send asset (`'100'`, `'0.5'`); the server scales it by
	 * the asset's decimals. The quote comes back in raw integer strings. Never pass `parseUnits`
	 * output here: `'10000'` is ten thousand of the asset, not 0.01.
	 */
	async quoteSwap(send: string, receive: string, amount: string, slippageBps = 50): Promise<Quote> {
		requireSlippage(slippageBps);
		await this.validateAmount(amount, send);
		await this.decimalsOf(receive);
		return this.quote('/vault/v1/quote/swap', swapBody(send, receive, amount, slippageBps), true);
	}

	/**
	 * A dry preview. Nothing is created and nothing is signed.
	 *
	 * `amount` is a HUMAN decimal string in `asset` (`'25'`, `'0.01'`); the server scales it. The quote
	 * comes back in raw integer strings. Never pass `parseUnits` output here.
	 */
	async quoteWithdraw(asset: string, amount: string, to: string, mode = 'exact_out'): Promise<Quote> {
		await this.validateAmount(amount, asset);
		return this.quote('/vault/v1/quote/withdraw', { asset, amount, to, mode }, true);
	}

	// ── money ────────────────────────────────────────────────────────────────

	/**
	 * Swaps `amount` of `send` for `receive`, delivered back to this vault: a real movement, co-signed.
	 * Full-key secrets only.
	 *
	 * `amount`, `minReceive` and `maxDebit` are HUMAN decimal strings (`'100'`, `'99.5'`) that the
	 * server scales by each asset's decimals — never `parseUnits` output, which would be read as that
	 * many whole units: `swap('USDC@base', 'USDT@base', '10000')` swaps ten thousand USDC.
	 */
	async swap(
		send: string,
		receive: string,
		amount: string,
		{
			slippageBps = 50,
			minReceive,
			maxDebit,
			idempotencyKey
		}: { slippageBps?: number; minReceive?: string; maxDebit?: string; idempotencyKey?: string } = {}
	): Promise<Movement> {
		this.requireShare('swap');
		requireSlippage(slippageBps);
		const key = idempotencyKeyOf(idempotencyKey);
		const sendDec = await this.validateAmount(amount, send);
		const recvDec = await this.decimalsOf(receive);

		const q = await this.quote('/vault/v1/quote/swap', swapBody(send, receive, amount, slippageBps), false, key);

		if (minReceive !== undefined) {
			const floor = BigInt(parseUnits(minReceive, recvDec));
			if (big(q.receive.min, 'quote.receive.min') < floor) {
				throw new SlippageExceeded(
					`guaranteed receive ${q.receive.min} is below the requested minimum ${floor} (${minReceive} ${receive})`
				);
			}
		}
		// A swap is exact_in, so the send leg must be exactly what was approved.
		this.verifyQuoteEcho(q, send, receive, { expectSendRaw: BigInt(parseUnits(amount, sendDec)) });
		this.enforceMaxDebit(q, maxDebit, sendDec);
		await this.cosign(q);
		return this.movement(requireMovementId(q));
	}

	/**
	 * Pays `amount` of `asset` out to `to`: a real movement, co-signed. Full-key secrets only.
	 *
	 * `amount` and `maxDebit` are HUMAN decimal strings (`'25'`, `'0.01'`) that the server scales by
	 * the asset's decimals — never `parseUnits` output. `withdraw('USDC@base', '10000', to)`, which is
	 * what `parseUnits('0.01', 6)` returns, pays out ten thousand USDC, and since the SDK and the server
	 * agree on that number no check can tell it from an intended one.
	 */
	async withdraw(
		asset: string,
		amount: string,
		to: string,
		{
			mode = 'exact_out',
			maxDebit,
			idempotencyKey
		}: { mode?: string; maxDebit?: string; idempotencyKey?: string } = {}
	): Promise<Movement> {
		this.requireShare('withdraw');
		const key = idempotencyKeyOf(idempotencyKey);
		const dec = await this.validateAmount(amount, asset);

		const q = await this.quote('/vault/v1/quote/withdraw', { asset, amount, to, mode }, false, key);

		// A withdraw is same-asset. For exact_out the approved amount is the guaranteed OUT; for
		// total_in it is the total DEBIT — and the send leg is total minus fees, so pinning send
		// would false-fail every time.
		const expected = BigInt(parseUnits(amount, dec));
		if (mode === 'total_in') this.verifyQuoteEcho(q, asset, asset, { maxDebitRaw: expected });
		else this.verifyQuoteEcho(q, asset, asset, { expectReceiveRaw: expected });

		this.enforceMaxDebit(q, maxDebit, dec);
		await this.cosign(q);
		return this.movement(requireMovementId(q));
	}

	// ── internals ────────────────────────────────────────────────────────────

	private requireShare(op: string): void {
		if (!this.#secret.hasShare) {
			throw new PaymosError(`${op} needs a full-scope secret: this one carries no co-signing share`);
		}
	}

	/**
	 * Label → asset, FIRST catalogue entry wins — the entry the server itself resolves a label to.
	 * `new Map(entries)` keeps the last, which would convert amounts with another entry's decimals
	 * whenever /assets lists one label twice. (The fingerprint SET is different: any entry with the
	 * first one's decimals counts — see `acceptedFingerprints`.)
	 */
	private async assetMap(): Promise<Map<string, Asset>> {
		if (!this.assetCache) {
			this.assetList = await this.assets();
			const map = new Map<string, Asset>();
			for (const a of this.assetList) if (!map.has(a.asset)) map.set(a.asset, a);
			this.assetCache = map;
		}
		return this.assetCache;
	}

	/**
	 * Every fingerprint a disclosed token of `label` may hash to. A pinned label: only the pins — the
	 * integrator vouches for them. An unpinned one: the fingerprints /assets publishes under it, from
	 * every entry whose decimals EQUAL the first entry's. The catalogue can list one label twice (two
	 * contracts of one coin), and keeping only one would refuse a legitimate co-sign from the other.
	 * But the debit the sources are summed against is in the first entry's units: a same-label token
	 * with other decimals would let a raw amount under the debit be worth 10^Δ more, so it is out.
	 */
	private async acceptedFingerprints(label: string): Promise<ReadonlySet<string>> {
		const pinned = this.pins.get(label);
		if (pinned) return pinned;
		const first = (await this.assetMap()).get(label);
		if (!first) return new Set();
		return new Set(
			(this.assetList ?? [])
				.filter((a) => a.asset === label && a.decimals === first.decimals && a.fingerprint)
				.map((a) => a.fingerprint!.toLowerCase())
		);
	}

	private async decimalsOf(asset: string): Promise<number> {
		const found = (await this.assetMap()).get(asset);
		if (!found) throw new PaymosError(`unknown asset: ${asset}`);
		return found.decimals;
	}

	/** Rejects a bad decimal before anything reaches the server — as a PaymosError, like Python. */
	private async validateAmount(amount: string, asset: string): Promise<number> {
		const dec = await this.decimalsOf(asset);
		try {
			parseUnits(amount, dec);
		} catch (e) {
			throw new PaymosError((e as Error).message);
		}
		return dec;
	}

	private async quote(path: string, body: Json, dry: boolean, idempotencyKey?: string): Promise<Quote> {
		const headers = idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined;
		return toQuote(await this.#http.post(path, { ...body, dry }, headers));
	}

	/**
	 * Refuse to sign unless the server's quote echoes what the caller approved: a units bug, contract
	 * drift or a lying server that changes one of these numbers is caught before a commitment exists.
	 * It pins what the caller typed — for exact_out the receive leg, not the debit, which stays the
	 * server's number unless `maxDebit` caps it.
	 */
	private verifyQuoteEcho(
		q: Quote,
		sendAsset: string,
		receiveAsset: string,
		expect: { expectSendRaw?: bigint; expectReceiveRaw?: bigint; maxDebitRaw?: bigint }
	): void {
		if (q.send.asset !== sendAsset || q.receive.asset !== receiveAsset) {
			throw new PaymosError(
				`quote is for ${q.send.asset}→${q.receive.asset}, not the ${sendAsset}→${receiveAsset} that was approved`
			);
		}
		if (expect.expectSendRaw !== undefined && big(q.send.amount, 'quote.send') !== expect.expectSendRaw) {
			throw new PaymosError(`quote sends ${q.send.amount}, not the approved ${expect.expectSendRaw}`);
		}
		// Exactly, as in Python. This used to accept any `receive.min` at or above the approved amount,
		// so a quote paying out 1000 where 10 was approved passed — and the debit that pays for it is
		// the server's own number, so nothing downstream bounded it unless the caller set maxDebit.
		if (expect.expectReceiveRaw !== undefined && big(q.receive.amount, 'quote.receive') !== expect.expectReceiveRaw) {
			throw new PaymosError(`quote receives ${q.receive.amount}, not the approved ${expect.expectReceiveRaw}`);
		}
		if (expect.maxDebitRaw !== undefined && big(q.debit.amount, 'quote.debit') > expect.maxDebitRaw) {
			throw new PaymosError(`quote debits ${q.debit.amount}, above the approved ${expect.maxDebitRaw}`);
		}
	}

	private enforceMaxDebit(q: Quote, maxDebit: string | undefined, decimals: number): void {
		if (maxDebit === undefined) return;
		const cap = BigInt(parseUnits(maxDebit, decimals));
		if (big(q.debit.amount, 'quote.debit') > cap) {
			throw new PaymosError(`quote debits ${q.debit.amount}, above the cap ${cap} (${maxDebit})`);
		}
	}

	/** Drives the 2-of-2 round: commit per source, verify the disclosure, sign, aggregate. */
	private async cosign(q: Quote): Promise<void> {
		const mid = encodeURIComponent(requireMovementId(q));
		const n = q.sources;
		if (n == null || n < 1) throw new PaymosError('quote is missing its source count — cannot co-sign');

		// Both anchors of the disclosure check are settled before a commitment leaves the process. A
		// missing one refuses the co-sign; it never quietly turns its check off.
		const kp = this.clientKeyPackage();
		if (typeof kp.verifying_key !== 'string' || !kp.verifying_key) {
			throw new PaymosError('co-sign refused: the key package carries no verifying_key — cannot check the signer');
		}
		const accepted = await this.acceptedFingerprints(q.send.asset);
		if (accepted.size === 0) {
			throw new PaymosError('co-sign refused: the server did not publish an asset fingerprint — update the server');
		}

		const commitments: Json[] = [];
		const nonces: Json[] = [];
		for (let i = 0; i < n; i++) {
			const { commitments: c, nonces: nn } = frostCommit(kp);
			commitments.push(c);
			nonces.push(nn);
		}

		let begin: Json;
		try {
			begin = expectObject(
				await this.#http.post(`/vault/v1/movements/${mid}/sign/begin`, { commitments }),
				'sign/begin'
			);
		} catch (e) {
			// An ambiguous failure after the server already progressed the movement is not a reason to
			// sign it a second time.
			const mv = await this.movement(requireMovementId(q));
			if (PROGRESSED.has(mv.status)) return;
			throw e;
		}

		if (typeof begin.token !== 'string' || !begin.token) {
			throw new PaymosError('malformed response: sign/begin has no token');
		}
		const packages = expectArray(begin.signing_packages, 'sign/begin signing_packages') as Json[];
		if (packages.length !== n) {
			throw new PaymosError(`co-sign protocol mismatch: expected ${n} signing packages, got ${packages.length}`);
		}

		verifySigningDisclosure(q, packages, begin.messages, kp.verifying_key, accepted);

		const shares = packages.map((pkg, i) => frostSign(pkg, nonces[i] as Json, kp));
		// A 4xx `{ok:false, error}` is raised by the transport; a 2xx that still says `ok:false` is
		// caught here. Either way a round-two failure always propagates — it is never swallowed.
		const res = expectObject(
			await this.#http.post(`/vault/v1/movements/${mid}/sign/aggregate`, { token: begin.token, shares }),
			'sign/aggregate'
		);
		if (res.ok !== true) {
			throw new PaymosError(typeof res.error === 'string' && res.error ? res.error : 'sign failed');
		}
	}

	private clientKeyPackage(): Json {
		if (this.#secret.share === null) throw new PaymosError('this secret carries no co-signing share');
		return JSON.parse(this.#secret.share) as Json;
	}
}

/** The catalogue's fingerprint of a raw asset id: lowercase hex SHA-256 of its UTF-8 bytes. */
function fingerprintOf(rawAssetId: string): string {
	return createHash('sha256').update(rawAssetId, 'utf8').digest('hex');
}

function expectArray(body: unknown, what: string): unknown[] {
	if (!Array.isArray(body)) throw new PaymosError(`malformed response: ${what} is not a JSON array`);
	return body;
}

function expectObject(body: unknown, what: string): Json {
	if (!isObject(body)) throw new PaymosError(`malformed response: ${what} is not a JSON object`);
	return body;
}

/**
 * The swap request, `mode` included. The server defaults a missing mode to exact_in today, but the
 * echo check below pins the send leg on exactly that assumption — so it is said on the wire, as the
 * contract fixture says it, rather than left to a default that could change underneath it.
 */
function swapBody(send: string, receive: string, amount: string, slippageBps: number): Json {
	return { send, receive, amount, mode: 'exact_in', slippage_bps: slippageBps };
}

/**
 * The key a money call is sent under: the caller's, or a fresh one when they passed none. An empty
 * or blank key is refused. It used to be kept — `'' ?? fresh` is `''` — and then dropped from the
 * request as falsy, so the call went out with no key at all and a retry paid again, while the
 * caller believed it was deduplicated.
 */
function idempotencyKeyOf(key: string | undefined): string {
	if (key == null) return crypto.randomUUID().replace(/-/g, '');
	if (typeof key !== 'string' || !key.trim()) {
		throw new PaymosError(
			'idempotencyKey is empty — pass a durable key (a payout or job id) so a retry replays the same movement, or leave it out for a fresh one per call'
		);
	}
	return key;
}

function requireSlippage(bps: number): void {
	if (!Number.isInteger(bps) || bps < 0) throw new PaymosError(`slippageBps must be a non-negative integer: ${bps}`);
}

function requireMovementId(q: Quote): string {
	if (!q.movementId) throw new PaymosError('quote created no movement — cannot sign a dry preview');
	return q.movementId;
}

/**
 * Never blind-sign. The server discloses, per source, the plaintext message it wants signed. For
 * each one this recomputes the digest and confirms the package about to be signed binds to exactly
 * that message; confirms the message is a single transfer from THIS vault, for a positive amount, of
 * a token whose hash is one of `accepted` (the send asset's fingerprints: pinned by the caller, else
 * as /assets publishes them); and confirms the sources together move no more than the approved
 * debit. Any mismatch aborts before a share is produced.
 *
 * Not checked: the transfer's `receiver_id` — the route's deposit address, chosen by the server. And
 * "no more than the approved debit" bounds the sources by the quote's debit, which for exact_out is
 * computed by the server; only `maxDebit` makes it the caller's number.
 */
function verifySigningDisclosure(
	q: Quote,
	packages: Json[],
	messages: unknown,
	verifyingKey: string,
	accepted: ReadonlySet<string>
): void {
	if (!Array.isArray(messages) || messages.length !== packages.length) {
		throw new PaymosError(
			'co-sign refused: the server did not disclose the signing messages — refusing to blind-sign'
		);
	}
	const expectedSigner = verifyingKey.toLowerCase();
	if (!expectedSigner || accepted.size === 0) {
		throw new PaymosError('co-sign refused: nothing to check the disclosure against');
	}
	let total = 0n;

	for (let i = 0; i < packages.length; i++) {
		const disc = (messages[i] ?? {}) as Json;
		const message = disc.message;
		const nonceHex = disc.nonce;
		const recipient = disc.recipient;
		if (typeof message !== 'string' || typeof nonceHex !== 'string' || typeof recipient !== 'string') {
			throw new PaymosError(`co-sign refused: malformed disclosure for source ${i}`);
		}

		// (1) binding: the package about to be signed hashes to EXACTLY the disclosed message.
		let want: string;
		try {
			want = payloadDigestHex(message, hexToBytes(nonceHex), recipient);
		} catch (e) {
			throw new PaymosError(`co-sign refused: malformed disclosure for source ${i}: ${(e as Error).message}`);
		}
		const pkg = packages[i];
		const got = isObject(pkg) ? pkg.message : undefined;
		if (typeof got !== 'string' || got.toLowerCase() !== want) {
			throw new PaymosError(`co-sign refused: signing package ${i} does not bind to the disclosed message`);
		}

		// (2) structure and own-vault: one transfer, signed from this vault and no other. Parsed
		// strictly: the verifier on chain re-parses these exact bytes and rejects a repeated key,
		// where JSON.parse would quietly keep the last one (strict-json.ts).
		let parsed: unknown;
		try {
			parsed = parseStrict(message);
		} catch (e) {
			throw new PaymosError(`co-sign refused: unreadable message for source ${i}: ${(e as Error).message}`);
		}
		if (!isObject(parsed) || typeof parsed.signer_id !== 'string') {
			throw new PaymosError(`co-sign refused: unreadable message for source ${i}`);
		}
		const list = parsed.intents;
		const signerId = parsed.signer_id.toLowerCase();
		if (!Array.isArray(list) || list.length !== 1) {
			throw new PaymosError(`co-sign refused: source ${i} is not a single transfer`);
		}
		const one = list[0];
		if (!isObject(one) || one.intent !== 'transfer') {
			throw new PaymosError(`co-sign refused: source ${i} is not a single transfer`);
		}
		if (signerId !== expectedSigner) {
			throw new PaymosError(`co-sign refused: source ${i} signs from a different vault`);
		}
		const tokens = one.tokens;
		if (!isObject(tokens) || Object.keys(tokens).length !== 1) {
			throw new PaymosError(`co-sign refused: source ${i} does not transfer exactly one token`);
		}
		// (3) the asset: every source moves the quote's SEND asset, by fingerprint. This binds the token
		// to the fingerprint the server publishes, so it catches a server bug or a compromised signing
		// path moving the approved units of another token. A server that lies in /assets too is only
		// caught when the caller pins fingerprints out of band (`pinnedFingerprints`).
		const [tokenKey, amount] = Object.entries(tokens)[0]!;
		if (!accepted.has(fingerprintOf(tokenKey))) {
			throw new PaymosError(`co-sign refused: source ${i} moves a different asset than ${q.send.asset}`);
		}
		// ASCII digits and above zero. BigInt would take "-900", "0x10" and " 5": a negative source
		// lowers the counted total while another moves more than the approved debit, and check (4)
		// would pass the pair. A zero transfer is no transfer at all, and the server never builds one.
		if (typeof amount !== 'string' || !/^[0-9]+$/.test(amount) || BigInt(amount) === 0n) {
			throw new PaymosError(`co-sign refused: bad transfer amount for source ${i}`);
		}
		total += BigInt(amount);
	}

	// (4) no inflation past the approved debit — the quote's number, capped by `maxDebit` if set.
	const approved = big(q.debit.amount, 'quote.debit');
	if (total > approved) {
		throw new PaymosError(`co-sign refused: sources move ${total}, above the approved debit ${approved}`);
	}
}
