/**
 * The SDK's half of the 2-of-2 co-sign, over the same Rust core the Python SDK and the .NET server
 * call. Nobody reimplements FROST: this is a JSON op in, a JSON op out, and the bytes signed here
 * are the bytes those two would sign.
 *
 * Only two operations run client-side in production:
 *
 *   commit — round one. Fresh per-session nonces plus the public commitment the server needs to
 *            build the signing package. Called once PER movement source; each source is its own
 *            signing session with its own nonces.
 *   sign   — round two. This side's signature share for one signing package.
 *
 * `buildSigningPackage` and `aggregate` are server-side operations and are deliberately absent.
 *
 * Every blob — keyPackage, commitments, nonces, signingPackage, signatureShare — is opaque. It is
 * passed through verbatim, never inspected and never rebuilt. The key package never reaches the
 * wire: it only ever feeds the local core.
 */
import { createRequire } from 'node:module';
import { PaymosError } from './errors.js';

type Json = Record<string, unknown>;

interface WasmModule {
	mpc_call_wasm(req: string): string;
}

let wasm: WasmModule | null = null;

/** Loaded on first use so importing the package costs nothing until something is signed. */
function core(): WasmModule {
	if (wasm) return wasm;
	try {
		const require = createRequire(import.meta.url);
		wasm = require('../wasm/wallet_mpc.js') as WasmModule;
	} catch (e) {
		throw new PaymosError(
			`co-signing core is unavailable: ${(e as Error).message}. ` +
				'Run `npm run build:wasm` if you are working from a source checkout.'
		);
	}
	return wasm;
}

function call(req: Json): Json {
	const raw = core().mpc_call_wasm(JSON.stringify(req));
	let r: unknown;
	try {
		r = JSON.parse(raw);
	} catch (e) {
		throw new PaymosError(`mpc call returned non-JSON: ${(e as Error).message}`);
	}
	if (!r || typeof r !== 'object' || !(r as Json).ok) {
		const msg = r && typeof r === 'object' ? (r as Json).error : null;
		throw new PaymosError(typeof msg === 'string' && msg ? msg : 'mpc call failed');
	}
	return r as Json;
}

/** Round one for one signing session. Send `commitments` to sign/begin; keep `nonces` private. */
export function commit(keyPackage: Json): { commitments: Json; nonces: Json } {
	const r = call({ op: 'commit', key_package: keyPackage });
	return { commitments: r.commitments as Json, nonces: r.nonces as Json };
}

/** Round two: this side's signature share, which the server aggregates with its own. */
export function sign(signingPackage: Json, nonces: Json, keyPackage: Json): Json {
	const r = call({ op: 'sign', signing_package: signingPackage, nonces, key_package: keyPackage });
	return r.signature_share as Json;
}
