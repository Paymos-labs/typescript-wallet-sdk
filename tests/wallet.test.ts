/**
 * The two contract fixes this file guards:
 *
 *   movements() reads the keyset page the server actually sends — `{items, next_cursor}` —
 *   not a `movements` key that never existed, and returns the cursor so a caller can page.
 *
 *   wait() stops at ALL FIVE terminal statuses — a refunded or expired movement is settled,
 *   not a reason to poll until timeout.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Wallet } from '../dist/wallet.js';
import { VaultSecret } from '../dist/secret.js';

const READ_SECRET = VaultSecret.pack('vk_live_abc123', 42, null);

const MOVEMENT_ROW = {
	id: 'mov_1',
	type: 'swap',
	status: 'completed',
	send: { amount: '1000000', asset: 'USDC@base' },
	receive: { amount: '990000', min: '985000', asset: 'ETH@arb' },
	fees: null,
	dest_chain_tx_hash: null,
	dest_chain_explorer_url: null,
	created_at: '2026-08-19T00:00:00Z',
	completed_at: null
};

const walletOver = (handler: (url: string) => unknown) =>
	new Wallet(READ_SECRET, {
		baseUrl: 'https://example.test',
		fetch: (async (url: unknown) => {
			const body = handler(String(url));
			return new Response(JSON.stringify(body), { status: 200 });
		}) as typeof fetch
	});

test('movements returns the keyset page and its cursor', async () => {
	const w = walletOver(() => ({ items: [MOVEMENT_ROW], next_cursor: 'cur_2' }));
	const page = await w.movements(2);
	assert.equal(page.items.length, 1);
	assert.equal(page.items[0].id, 'mov_1');
	assert.equal(page.nextCursor, 'cur_2');
});

test('movements reports the end of the history as a null cursor', async () => {
	const w = walletOver(() => ({ items: [], next_cursor: null }));
	const page = await w.movements();
	assert.deepEqual(page.items, []);
	assert.equal(page.nextCursor, null);
});

test('wait returns on every terminal status, not just two of them', async () => {
	for (const status of ['completed', 'failed', 'refunded', 'expired', 'cancelled']) {
		const w = walletOver(() => ({ ...MOVEMENT_ROW, status }));
		const mv = await w.wait('mov_1', { intervalMs: 1 });
		assert.equal(mv.status, status);
	}
});

test('wait times out on a movement that never settles', async () => {
	const w = walletOver(() => ({ ...MOVEMENT_ROW, status: 'relaying' }));
	await assert.rejects(w.wait('mov_1', { timeoutMs: 5, intervalMs: 1 }), /timed out/);
});
