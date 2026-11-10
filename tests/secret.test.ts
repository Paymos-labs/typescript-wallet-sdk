import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { Http } from '../dist/http.js';
import { VaultSecret } from '../dist/secret.js';
import { Wallet } from '../dist/wallet.js';

const FULL = VaultSecret.pack('vk_live_abc123', 42, '{"share":"x"}');
const READ = VaultSecret.pack('vk_live_abc123', 42, null);

test('packs then parses, full and read-only', () => {
	const full = VaultSecret.parse(FULL);
	assert.equal(full.apiKey, 'vk_live_abc123');
	assert.equal(full.vaultId, 42);
	assert.equal(full.hasShare, true);

	const read = VaultSecret.parse(READ);
	assert.equal(read.hasShare, false);
	assert.equal(read.share, null);
});

test('rejects anything that is not a vault secret', () => {
	for (const bad of ['sk_prod_not_ours', 'vk_test_dev_key', '', 'vs_live_@@@']) {
		assert.throws(() => VaultSecret.parse(bad as string));
	}
});

test('rejects a secret whose api key is not one of ours', () => {
	assert.throws(() => VaultSecret.parse(VaultSecret.pack('nope', 1, null)));
});

test('never renders the share and masks the key', () => {
	const s = VaultSecret.parse(FULL);
	for (const rendered of [s.toString(), JSON.stringify(s), inspect(s), inspect({ nested: { s } }, { depth: 5 })]) {
		assert.ok(!rendered.includes('share":"x'), 'the share must never be rendered');
		assert.ok(!rendered.includes('abc123'), 'the key must be masked');
		assert.ok(rendered.includes('vk_live_'), 'the non-secret prefix is fine to show');
	}
});

test('a stray console.log or JSON.stringify of the wallet or its transport carries no credential', () => {
	// console.log prints with util.inspect, which reads neither toString nor toJSON. The README
	// promises a stray console.log is safe; this is that promise, for every printer a log line uses.
	const wallet = new Wallet(FULL, { baseUrl: 'https://vault.test' });
	const http = new Http('https://vault.test', 'vk_live_abc123');
	const rendered = [
		inspect(wallet),
		inspect(wallet, { depth: 10, showHidden: true }),
		inspect(wallet, { customInspect: false, depth: 10 }),
		inspect({ job: { wallet, http } }, { depth: 10 }),
		inspect(http, { customInspect: false }),
		JSON.stringify(wallet),
		JSON.stringify({ job: { wallet, http } }),
		JSON.stringify(Object.entries(wallet)),
		JSON.stringify({ ...wallet }),
		String(wallet)
	];
	for (const r of rendered) {
		assert.ok(!r.includes('abc123'), `the key leaked: ${r}`);
		assert.ok(!r.includes('share":"x') && !r.includes('"share"'), `the share leaked: ${r}`);
	}
	assert.match(inspect(wallet), /^Wallet\(vaultId=42, hasShare=true, apiKey=vk_live_…\)$/);
});
