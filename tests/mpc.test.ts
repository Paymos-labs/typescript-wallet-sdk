/**
 * Proves the TypeScript SDK drives the same co-signing core the Python SDK and the server drive:
 * a full 2-of-2 round — two parties, distributed key generation, commit, sign, aggregate — and the
 * resulting ed25519 signature verifies. If this passes, the halves agree on what a signature is.
 *
 * The server-side operations are driven directly here rather than through the SDK, because the SDK
 * deliberately cannot perform them: it holds one half and no more.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { commit, sign } from '../dist/mpc.js';

const require = createRequire(import.meta.url);
const wasm = require('../wasm/wallet_mpc.js') as { mpc_call_wasm(s: string): string };
const call = (o: unknown): any => JSON.parse(wasm.mpc_call_wasm(JSON.stringify(o)));

const CLIENT = 1;
const SERVER = 2;

test('co-signs a real 2-of-2 signature with the server half', () => {
	const a1 = call({ op: 'dkg_part1', id: CLIENT, max: 2, min: 2 });
	const b1 = call({ op: 'dkg_part1', id: SERVER, max: 2, min: 2 });
	const a2 = call({ op: 'dkg_part2', secret: a1.secret, round1_packages: [[SERVER, b1.package]] });
	const b2 = call({ op: 'dkg_part2', secret: b1.secret, round1_packages: [[CLIENT, a1.package]] });
	const forClient = b2.packages.find((x: [number, unknown]) => x[0] === CLIENT)[1];
	const forServer = a2.packages.find((x: [number, unknown]) => x[0] === SERVER)[1];
	const a3 = call({
		op: 'dkg_part3',
		secret: a2.secret,
		round1_packages: [[SERVER, b1.package]],
		round2_packages: [[SERVER, forClient]]
	});
	const b3 = call({
		op: 'dkg_part3',
		secret: b2.secret,
		round1_packages: [[CLIENT, a1.package]],
		round2_packages: [[CLIENT, forServer]]
	});
	assert.equal(a3.group_pubkey_hex, b3.group_pubkey_hex, 'both halves derive one group key');

	// The client half goes through the SDK; the server half is driven directly, because the SDK
	// has no way to perform it and that is the point.
	const client = commit(a3.key_package);
	const server = call({ op: 'commit', key_package: b3.key_package });

	const pkg = call({
		op: 'build_signing_package',
		commitments: [
			[CLIENT, client.commitments],
			[SERVER, server.commitments]
		],
		message_hex: 'deadbeef'
	});

	const clientShare = sign(pkg.signing_package, client.nonces, a3.key_package);
	const serverShare = call({
		op: 'sign',
		signing_package: pkg.signing_package,
		nonces: server.nonces,
		key_package: b3.key_package
	});

	const agg = call({
		op: 'aggregate',
		signing_package: pkg.signing_package,
		signature_shares: [
			[CLIENT, clientShare],
			[SERVER, serverShare.signature_share]
		],
		public_key_package: a3.public_key_package
	});
	assert.equal(agg.verified, true, `aggregate verifies: ${JSON.stringify(agg)}`);
});

test('reports a failed op instead of returning nonsense', () => {
	assert.throws(() => sign({} as never, {} as never, {} as never), /mpc call failed|.+/);
});
