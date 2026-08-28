/**
 * The entry point, ported from the Python SDK. Same methods, same guarantees, same refusals.
 *
 * Everything that moves money goes through a 2-of-2 co-sign in which this process holds one half of
 * the key and never sends it anywhere. The server cannot sign alone and neither can this — which is
 * only worth anything if this side refuses to sign things it has not checked, so it does:
 *
 *   the quote must echo what was approved   — a decimals bug or a lying server changes the numbers,
 *                                             and the numbers are compared before a commitment
 *   the debit may be capped                 — for an exact_out payout the input side is computed by
 *                                             the server, so `maxDebit` is the caller's ceiling
 *   never blind-sign                        — the server discloses each message, this side recomputes
 *                                             the digest and refuses unless the package binds to it
 *
 * Any of those failing raises before a single signature share exists.
 */
import { parseUnits } from './amounts.js';
import { payloadDigestHex } from './digest.js';
import { PaymosError, SlippageExceeded } from './errors.js';
import { Http, type HttpOptions } from './http.js';
import { commit as frostCommit, sign as frostSign } from './mpc.js';
import { VaultSecret } from './secret.js';
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

/** A movement in any of these states has already been signed; a retry must not sign again. */
const PROGRESSED = new Set(['signed', 'relaying', 'relayed', 'settling', 'completed', 'failed']);

/** A movement is settled (no more polling) once it reaches one of these. */
const TERMINAL = new Set(['completed', 'failed', 'refunded', 'expired', 'cancelled']);

const hexToBytes = (hex: string): Uint8Array => {
	if (hex.length % 2) throw new PaymosError(`odd-length hex: ${hex.length} chars`);
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
};

export interface WalletOptions extends HttpOptions {
	baseUrl?: string;
}

export class Wallet {
	private readonly secret: VaultSecret;
	private readonly http: Http;
	private assetCache: Map<string, Asset> | null = null;

	constructor(secret: string, options: WalletOptions = {}) {
		this.secret = VaultSecret.parse(secret);
		const baseUrl = options.baseUrl ?? process.env.PAYMOS_BASE_URL ?? 'https://wallet.paymos.io';
		this.http = new Http(baseUrl, this.secret.apiKey, options);
	}

	/** Reads `PAYMOS_VAULT_SECRET`, the way a deployed process is configured. */
	static fromEnv(options: WalletOptions = {}): Wallet {
		const secret = process.env.PAYMOS_VAULT_SECRET;
		if (!secret) throw new PaymosError('PAYMOS_VAULT_SECRET is not set');
		return new Wallet(secret, options);
	}

	// ── reads ────────────────────────────────────────────────────────────────

	async assets(): Promise<Asset[]> {
		const body = (await this.http.get('/vault/v1/assets')) as Json;
		return ((body.assets ?? []) as unknown[]).map(toAsset);
	}

	async balances(): Promise<Balance[]> {
		const body = (await this.http.get('/vault/v1/balances')) as Json;
		return ((body.balances ?? []) as unknown[]).map(toBalance);
	}

	async movement(movementId: string): Promise<Movement> {
		return toMovement(await this.http.get(`/vault/v1/movements/${encodeURIComponent(movementId)}`));
	}

	/**
	 * A page of the caller's movement history (newest first, summary rows without fee legs) and
	 * the next cursor; pass it back as `cursor` for the next page (null when exhausted). The
	 * server speaks keyset pagination: `items` + `next_cursor`.
	 */
	async movements(limit = 50, cursor?: string): Promise<{ items: Movement[]; nextCursor: string | null }> {
		const body = (await this.http.get('/vault/v1/movements', { limit, cursor })) as Json;
		const items = ((body.items ?? []) as unknown[]).map(toMovement);
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

	/** A dry preview. Nothing is created and nothing is signed. */
	async quoteSwap(send: string, receive: string, amount: string, slippageBps = 50): Promise<Quote> {
		await this.validateAmount(amount, send);
		await this.decimalsOf(receive);
		return this.quote('/vault/v1/quote/swap', { send, receive, amount, slippage_bps: slippageBps }, true);
	}

	/** A dry preview. Nothing is created and nothing is signed. */
	async quoteWithdraw(asset: string, amount: string, to: string, mode = 'exact_out'): Promise<Quote> {
		await this.validateAmount(amount, asset);
		return this.quote('/vault/v1/quote/withdraw', { asset, amount, to, mode }, true);
	}

	// ── money ────────────────────────────────────────────────────────────────

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
		const sendDec = await this.validateAmount(amount, send);
		const recvDec = await this.decimalsOf(receive);

		const q = await this.quote(
			'/vault/v1/quote/swap',
			{ send, receive, amount, slippage_bps: slippageBps },
			false,
			idempotencyKey ?? crypto.randomUUID().replace(/-/g, '')
		);

		if (minReceive !== undefined) {
			const floor = BigInt(parseUnits(minReceive, recvDec));
			if (BigInt(q.receive.min) < floor) {
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
		const dec = await this.validateAmount(amount, asset);

		const q = await this.quote(
			'/vault/v1/quote/withdraw',
			{ asset, amount, to, mode },
			false,
			idempotencyKey ?? crypto.randomUUID().replace(/-/g, '')
		);

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
		if (!this.secret.hasShare) {
			throw new PaymosError(`${op} needs a full-scope secret: this one carries no co-signing share`);
		}
	}

	private async assetMap(): Promise<Map<string, Asset>> {
		if (!this.assetCache) this.assetCache = new Map((await this.assets()).map((a) => [a.asset, a]));
		return this.assetCache;
	}

	private async decimalsOf(asset: string): Promise<number> {
		const found = (await this.assetMap()).get(asset);
		if (!found) throw new PaymosError(`unknown asset: ${asset}`);
		return found.decimals;
	}

	private async validateAmount(amount: string, asset: string): Promise<number> {
		const dec = await this.decimalsOf(asset);
		parseUnits(amount, dec); // throws on a bad decimal before anything reaches the server
		return dec;
	}

	private async quote(path: string, body: Json, dry: boolean, idempotencyKey?: string): Promise<Quote> {
		const headers = idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined;
		return toQuote(await this.http.post(path, { ...body, dry }, headers));
	}

	/**
	 * Refuse to sign unless the server's quote echoes what the caller approved. This is what makes
	 * co-signing a server-built movement safe: a units bug, contract drift or a compromised server
	 * changes one of these numbers, and the change is caught before a commitment exists.
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
		if (expect.expectSendRaw !== undefined && BigInt(q.send.amount) !== expect.expectSendRaw) {
			throw new PaymosError(`quote sends ${q.send.amount}, not the approved ${expect.expectSendRaw}`);
		}
		if (expect.expectReceiveRaw !== undefined && BigInt(q.receive.min) < expect.expectReceiveRaw) {
			throw new PaymosError(
				`quote guarantees ${q.receive.min}, below the approved ${expect.expectReceiveRaw}`
			);
		}
		if (expect.maxDebitRaw !== undefined && BigInt(q.debit.amount) > expect.maxDebitRaw) {
			throw new PaymosError(`quote debits ${q.debit.amount}, above the approved ${expect.maxDebitRaw}`);
		}
	}

	private enforceMaxDebit(q: Quote, maxDebit: string | undefined, decimals: number): void {
		if (maxDebit === undefined) return;
		const cap = BigInt(parseUnits(maxDebit, decimals));
		if (BigInt(q.debit.amount) > cap) {
			throw new PaymosError(`quote debits ${q.debit.amount}, above the cap ${cap} (${maxDebit})`);
		}
	}

	/** Drives the 2-of-2 round: commit per source, verify the disclosure, sign, aggregate. */
	private async cosign(q: Quote): Promise<void> {
		const mid = requireMovementId(q);
		const n = q.sources;
		if (n == null || n < 1) throw new PaymosError('quote is missing its source count — cannot co-sign');

		const kp = this.clientKeyPackage();
		const commitments: Json[] = [];
		const nonces: Json[] = [];
		for (let i = 0; i < n; i++) {
			const { commitments: c, nonces: nn } = frostCommit(kp);
			commitments.push(c);
			nonces.push(nn);
		}

		let begin: Json;
		try {
			begin = (await this.http.post(`/vault/v1/movements/${mid}/sign/begin`, { commitments })) as Json;
		} catch (e) {
			// An ambiguous failure after the server already progressed the movement is not a reason to
			// sign it a second time.
			const mv = await this.movement(mid);
			if (PROGRESSED.has(mv.status)) return;
			throw e;
		}

		const packages = (begin.signing_packages ?? []) as Json[];
		if (packages.length !== n) {
			throw new PaymosError(`co-sign protocol mismatch: expected ${n} signing packages, got ${packages.length}`);
		}

		verifySigningDisclosure(q, packages, begin.messages, kp);

		const shares = packages.map((pkg, i) => frostSign(pkg, nonces[i] as Json, kp));
		const res = (await this.http.post(`/vault/v1/movements/${mid}/sign/aggregate`, {
			token: begin.token,
			shares
		})) as Json;
		if (!res.ok) throw new PaymosError((res.error as string) || 'sign failed');
	}

	private clientKeyPackage(): Json {
		if (this.secret.share === null) throw new PaymosError('this secret carries no co-signing share');
		return JSON.parse(this.secret.share) as Json;
	}
}

function requireMovementId(q: Quote): string {
	if (!q.movementId) throw new PaymosError('quote created no movement — cannot sign a dry preview');
	return q.movementId;
}

/**
 * Never blind-sign. The server discloses, per source, the plaintext message it wants signed. For
 * each one this recomputes the digest and confirms the package about to be signed binds to exactly
 * that message; confirms the message is a single transfer from THIS vault; and confirms the sources
 * together move no more than the approved debit. Any mismatch aborts before a share is produced.
 */
function verifySigningDisclosure(q: Quote, packages: Json[], messages: unknown, kp: Json): void {
	if (!Array.isArray(messages) || messages.length !== packages.length) {
		throw new PaymosError(
			'co-sign refused: the server did not disclose the signing messages — refusing to blind-sign'
		);
	}
	const expectedSigner = String(kp.verifying_key ?? '').toLowerCase();
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
		const want = payloadDigestHex(message, hexToBytes(nonceHex), recipient);
		const got = packages[i]?.message;
		if (typeof got !== 'string' || got.toLowerCase() !== want) {
			throw new PaymosError(`co-sign refused: signing package ${i} does not bind to the disclosed message`);
		}

		// (2) structure and own-vault: one transfer, signed from this vault and no other.
		let parsed: Json;
		try {
			parsed = JSON.parse(message) as Json;
		} catch (e) {
			throw new PaymosError(`co-sign refused: unreadable message for source ${i}: ${(e as Error).message}`);
		}
		const list = parsed.intents;
		const signerId = String(parsed.signer_id ?? '').toLowerCase();
		if (!Array.isArray(list) || list.length !== 1) {
			throw new PaymosError(`co-sign refused: source ${i} is not a single transfer`);
		}
		const one = (list[0] ?? {}) as Json;
		if (one.intent !== 'transfer') {
			throw new PaymosError(`co-sign refused: source ${i} is not a single transfer`);
		}
		if (expectedSigner && signerId !== expectedSigner) {
			throw new PaymosError(`co-sign refused: source ${i} signs from a different vault`);
		}
		const tokens = one.tokens;
		if (!tokens || typeof tokens !== 'object' || Object.keys(tokens).length !== 1) {
			throw new PaymosError(`co-sign refused: source ${i} does not transfer exactly one token`);
		}
		try {
			total += BigInt(String(Object.values(tokens as Json)[0]));
		} catch {
			throw new PaymosError(`co-sign refused: bad transfer amount for source ${i}`);
		}
	}

	// (3) no inflation: the sources together move no more than the approved debit.
	const approved = BigInt(q.debit.amount);
	if (total > approved) {
		throw new PaymosError(`co-sign refused: sources move ${total}, above the approved debit ${approved}`);
	}
}
