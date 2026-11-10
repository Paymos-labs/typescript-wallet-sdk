/**
 * The `vs_live_…` vault secret: an API key, the vault id, and — for a full key — this side's FROST
 * signing share. Ported from the Python SDK, same envelope, same field names, so one secret works
 * with either language.
 */
import { PaymosError } from './errors.js';

const PREFIX = 'vs_live_';

const b64urlDecode = (s: string): Buffer => Buffer.from(s, 'base64url');

/** Show only the non-secret prefix, so a log line or a stack trace cannot carry a usable key. */
export const mask = (key: string): string => (key ? `${key.slice(0, 8)}…` : '…');

/**
 * Node's `util.inspect` — what `console.log` prints an object with — reads this symbol, not
 * `toString` or `toJSON`, and without it prints every own property. `Symbol.for` reaches it without
 * importing `node:util`; anywhere else the symbol is simply never consulted.
 */
export const INSPECT = Symbol.for('nodejs.util.inspect.custom');

export class VaultSecret {
	readonly apiKey: string;
	readonly vaultId: number;
	readonly share: string | null;

	constructor(apiKey: string, vaultId: number, share: string | null) {
		this.apiKey = apiKey;
		this.vaultId = vaultId;
		this.share = share;
	}

	get hasShare(): boolean {
		return this.share !== null;
	}

	/** Never renders the share, and masks the key: a stray console.log must not leak either. */
	toJSON(): Record<string, unknown> {
		return { apiKey: mask(this.apiKey), vaultId: this.vaultId, hasShare: this.hasShare };
	}

	toString(): string {
		return `VaultSecret(apiKey=${mask(this.apiKey)}, vaultId=${this.vaultId}, hasShare=${this.hasShare})`;
	}

	/** `console.log(secret)` and `util.inspect(secret)`: the same masked line, never the fields. */
	[INSPECT](): string {
		return this.toString();
	}

	static pack(apiKey: string, vaultId: number, share: string | null): string {
		const payload = JSON.stringify({ k: apiKey, v: vaultId, s: share });
		return PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
	}

	static parse(secret: string): VaultSecret {
		if (typeof secret !== 'string' || !secret.startsWith(PREFIX)) {
			throw new PaymosError('not a vs_live_ vault secret');
		}
		let o: { k?: unknown; v?: unknown; s?: unknown };
		try {
			o = JSON.parse(b64urlDecode(secret.slice(PREFIX.length)).toString('utf8'));
		} catch (e) {
			throw new PaymosError(`malformed vault secret: ${(e as Error).message}`);
		}
		const apiKey = o.k;
		if (typeof apiKey !== 'string' || !apiKey.startsWith('vk_live_')) {
			throw new PaymosError('vault secret carries no valid api key');
		}
		const vaultId = Number(o.v);
		if (!Number.isInteger(vaultId)) throw new PaymosError('vault secret carries no valid vault id');
		return new VaultSecret(apiKey, vaultId, o.s == null ? null : String(o.s));
	}
}
