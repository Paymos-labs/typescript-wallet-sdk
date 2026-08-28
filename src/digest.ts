/**
 * The exact 32 bytes the vault's signature is computed over — a byte-for-byte port of the Python
 * SDK's digest, which is itself pinned to the server by a cross-language golden vector.
 *
 * The SDK uses this to VERIFY, before a single FROST commitment leaves the process, that the server
 * disclosed the true message it is asking the vault to sign. Never blind-sign.
 *
 * digest = sha256 of:
 *   u32   tag                 fixed domain separation; must byte-match the server
 *   string message            u32-LE length prefix + utf-8
 *   bytes32 nonce             raw, exactly 32
 *   string recipient          u32-LE length prefix + utf-8
 *   option<string> callback   0x00 = none, else 0x01 + string
 *
 * Message and recipient are hashed as their EXACT utf-8 bytes. Re-formatting the payload changes the
 * digest, which is precisely what the binding check is there to catch.
 */
import { createHash } from 'node:crypto';

/** Part of the wire contract. Change it and the client and server stop agreeing forever. */
const MSG_TAG = 2147484061;

function lenPrefixedUtf8(s: string): Uint8Array {
	const body = new TextEncoder().encode(s);
	const out = new Uint8Array(4 + body.length);
	new DataView(out.buffer).setUint32(0, body.length, true);
	out.set(body, 4);
	return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/** The 32-byte sha256 digest the vault's ed25519 signature is over. `nonce` must be exactly 32. */
export function payloadDigest(
	message: string,
	nonce: Uint8Array,
	recipient: string,
	callbackUrl?: string | null
): Uint8Array {
	if (nonce.length !== 32) throw new RangeError(`nonce must be 32 bytes, got ${nonce.length}`);
	const tag = new Uint8Array(4);
	new DataView(tag.buffer).setUint32(0, MSG_TAG, true);
	const callback =
		callbackUrl === undefined || callbackUrl === null
			? new Uint8Array([0x00])
			: concat([new Uint8Array([0x01]), lenPrefixedUtf8(callbackUrl)]);
	const w = concat([tag, lenPrefixedUtf8(message), nonce, lenPrefixedUtf8(recipient), callback]);
	return new Uint8Array(createHash('sha256').update(w).digest());
}

/** The digest as lowercase hex — the form the FROST signing package carries, so the two compare. */
export function payloadDigestHex(
	message: string,
	nonce: Uint8Array,
	recipient: string,
	callbackUrl?: string | null
): string {
	return Buffer.from(payloadDigest(message, nonce, recipient, callbackUrl)).toString('hex');
}
