import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { VaultSecret } from '../dist/secret.js';

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
	for (const rendered of [s.toString(), JSON.stringify(s)]) {
		assert.ok(!rendered.includes('share":"x'), 'the share must never be rendered');
		assert.ok(!rendered.includes('abc123'), 'the key must be masked');
		assert.ok(rendered.includes('vk_live_'), 'the non-secret prefix is fine to show');
	}
});
