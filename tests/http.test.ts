/**
 * The error mapping, which is the whole reason this layer exists: a caller branches on a type
 * instead of matching a string, and the types must land the same way they do in Python.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Http } from '../dist/http.js';
import {
	AuthError,
	Conflict,
	CrossAssetWithdrawNotAllowed,
	Forbidden,
	InsufficientFunds,
	PaymosError,
	QuoteExpired,
	RateLimited,
	RouteUnavailable,
	SlippageExceeded
} from '../dist/errors.js';

const stub = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Http('https://example.test', 'vk_live_x', {
		fetch: async () =>
			new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
	});

test('returns parsed json on a 2xx', async () => {
	// /assets and /balances answer a bare array; there was never an `{assets: [...]}` wrapper.
	const body = [{ asset: 'USDC@base', symbol: 'USDC', chain: 'base', decimals: 6 }];
	assert.deepEqual(await stub(200, body).get('/x'), body);
});

test('maps status codes to types', async () => {
	const cases: [number, unknown, unknown][] = [
		[401, { error: 'bad key' }, AuthError],
		[403, { error: 'no scope' }, Forbidden],
		[409, { error: 'reused' }, Conflict],
		[404, { error: 'gone' }, PaymosError],
		[500, { error: 'boom' }, PaymosError]
	];
	for (const [status, body, type] of cases) {
		await assert.rejects(stub(status, body).get('/x'), type as never, `status ${status}`);
	}
});

test('classifies a 400 by its message, first match winning', async () => {
	const cases: [string, unknown][] = [
		['cross-asset withdraw is not allowed', CrossAssetWithdrawNotAllowed],
		['slippage exceeded', SlippageExceeded],
		['quote expired', QuoteExpired],
		['insufficient balance', InsufficientFunds],
		['available balance is lower', InsufficientFunds],
		['No liquidity available, try again in a moment', RouteUnavailable],
		["route can't be quoted", RouteUnavailable],
		['something else entirely', PaymosError]
	];
	for (const [message, type] of cases) {
		await assert.rejects(stub(400, { error: message }).get('/x'), type as never, message);
	}
});

test('carries Retry-After on a 429 when the server sends one', async () => {
	await assert.rejects(
		stub(429, { error: 'slow down' }, { 'retry-after': '12' }).get('/x'),
		(e: RateLimited) => e instanceof RateLimited && e.retryAfter === 12
	);
	await assert.rejects(
		stub(429, { error: 'slow down' }).get('/x'),
		(e: RateLimited) => e instanceof RateLimited && e.retryAfter === undefined
	);
});

test('falls back to the raw body when there is no error envelope', async () => {
	await assert.rejects(stub(500, 'upstream exploded').get('/x'), (e: PaymosError) =>
		e.message === 'upstream exploded'
	);
});

test('a 2xx that is not JSON is a typed error, not a null the caller trips over later', async () => {
	await assert.rejects(
		stub(200, '<!doctype html><html><body>Paymos</body></html>', { 'content-type': 'text/html' }).get('/x'),
		(e: PaymosError) => e instanceof PaymosError && e.status === 200 && /HTML page/.test(e.message)
	);
});

test('an HTML error page is summarised, not quoted whole', async () => {
	const page = `<!doctype html><html>${'x'.repeat(5000)}</html>`;
	await assert.rejects(stub(404, page).get('/x'), (e: PaymosError) =>
		e.status === 404 && /HTML page/.test(e.message) && e.message.length < 200
	);
});

test('wraps a transport failure instead of leaking it', async () => {
	const http = new Http('https://example.test', 'k', {
		fetch: async () => {
			throw new TypeError('connection reset');
		}
	});
	await assert.rejects(http.get('/x'), (e: PaymosError) => e instanceof PaymosError && e.status === undefined);
});

test('sends the bearer token and the idempotency key', async () => {
	let seen: Headers | undefined;
	const http = new Http('https://example.test', 'vk_live_secret', {
		fetch: async (_u, init) => {
			seen = new Headers(init?.headers);
			return new Response('{}', { status: 200 });
		}
	});
	await http.post('/x', { a: 1 }, { 'idempotency-key': 'abc' });
	assert.equal(seen?.get('authorization'), 'Bearer vk_live_secret');
	assert.equal(seen?.get('idempotency-key'), 'abc');
});
