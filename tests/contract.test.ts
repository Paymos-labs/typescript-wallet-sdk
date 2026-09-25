/**
 * The wire contract, read from disk. `sdk/contract/fixtures` is what the server's real request
 * pipeline answers (recorded by the server's contract test); this file
 * serves those bodies through a stubbed fetch and makes the SDK parse them, and checks that what the
 * SDK SENDS is what the fixture's request says.
 *
 * It exists because this suite once mocked `{"assets": [...]}` — a shape the server never sent — and
 * passed while every quote, swap and withdraw failed with "unknown asset". Nothing here is typed from
 * memory: a body either comes from a fixture or is derived from one, and says so.
 *
 * No network. The co-sign tests run a real 2-of-2 round over the wasm core, with the test playing the
 * server's half, because the fixtures' crypto values are placeholders that verify nothing.
 */
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Wallet, PROGRESSED, TERMINAL } from '../dist/wallet.js';
import { Http } from '../dist/http.js';
import { VaultSecret } from '../dist/secret.js';
import { payloadDigestHex } from '../dist/digest.js';
import { toQuote } from '../dist/types.js';
import { AuthError, Conflict, Forbidden, PaymosError } from '../dist/errors.js';

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * `contract/fixtures` walking up from here (the layout of a published mirror), then
 * `sdk/contract/fixtures` (this monorepo). Not finding them is a FAILURE, never a skip: a contract
 * suite that quietly runs nothing is the failure this file exists to prevent.
 */
function findFixtures(): string | null {
	for (const rel of ['contract/fixtures', 'sdk/contract/fixtures']) {
		let dir = dirname(fileURLToPath(import.meta.url));
		for (;;) {
			const candidate = join(dir, rel);
			if (existsSync(join(candidate, 'assets.json'))) return candidate;
			const up = dirname(dir);
			if (up === dir) break;
			dir = up;
		}
	}
	return null;
}

const FIXTURES = findFixtures();

interface Fixture {
	request: { method: string; path: string; body: any };
	response: { status: number; body: any };
}

function load(name: string): Fixture {
	assert.ok(FIXTURES, 'contract fixtures not found: looked for contract/fixtures and sdk/contract/fixtures above this file');
	return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as Fixture;
}

/** Every fixture this file serves. A new one on disk that is missing here fails the first test. */
const COVERED = [
	'assets',
	'balances',
	'error_400',
	'error_400_body',
	'error_401',
	'error_403',
	'error_404_movement',
	'error_404_path',
	'error_409_idempotency',
	'movement',
	'movements_page',
	'quote_swap',
	'quote_swap_dry',
	'quote_withdraw',
	'quote_withdraw_dry',
	'quote_withdraw_total_in',
	'sign_aggregate',
	'sign_aggregate_error',
	'sign_begin',
	'sign_begin_error',
	'vocabulary'
];

// ── a stubbed server ────────────────────────────────────────────────────────

interface Seen {
	method: string;
	path: string;
	headers: Headers;
	body: any;
}

type Reply = { status: number; body: unknown; raw?: boolean } | ((req: Seen) => { status: number; body: unknown });

const BASE = 'https://example.test';

/**
 * A fetch that answers `"<METHOD> <path?query>"` from `routes` and records every request. A route
 * nobody mocked is a thrown error (surfacing as a transport PaymosError), so a wrong path cannot
 * pass by accident.
 */
function server(routes: Record<string, Reply>) {
	const seen: Seen[] = [];
	const fetch = (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? 'GET';
		const req: Seen = {
			method,
			path: url.pathname + url.search,
			headers: new Headers(init?.headers),
			body: init?.body == null ? null : JSON.parse(String(init.body))
		};
		seen.push(req);
		const route = routes[`${method} ${req.path}`];
		if (!route) throw new Error(`unmocked ${method} ${req.path}`);
		const reply = typeof route === 'function' ? route(req) : route;
		const text = typeof reply.body === 'string' && (reply as { raw?: boolean }).raw ? reply.body : JSON.stringify(reply.body);
		return new Response(text, { status: reply.status });
	}) as typeof globalThis.fetch;
	return { fetch, seen };
}

/** Serve a fixture's response at the fixture's own request line. */
const route = (f: Fixture): [string, Reply] => [`${f.request.method} ${f.request.path}`, f.response];

const READ_SECRET = VaultSecret.pack('vk_live_contract', 7, null);

function readWallet(routes: Record<string, Reply>) {
	const s = server(routes);
	return { wallet: new Wallet(READ_SECRET, { baseUrl: BASE, fetch: s.fetch }), seen: s.seen };
}

// ── the server's half of the key, for the co-sign tests ─────────────────────

const require = createRequire(import.meta.url);
const wasm = require('../wasm/wallet_mpc.js') as { mpc_call_wasm(s: string): string };
const mpc = (o: unknown): any => {
	const r = JSON.parse(wasm.mpc_call_wasm(JSON.stringify(o)));
	assert.ok(r.ok, `mpc ${JSON.stringify(r)}`);
	return r;
};

const CLIENT = 1;
const SERVER = 2;

/** One fresh 2-of-2 DKG: the client key package goes into the secret, the server's stays here. */
function dkg() {
	const a1 = mpc({ op: 'dkg_part1', id: CLIENT, max: 2, min: 2 });
	const b1 = mpc({ op: 'dkg_part1', id: SERVER, max: 2, min: 2 });
	const a2 = mpc({ op: 'dkg_part2', secret: a1.secret, round1_packages: [[SERVER, b1.package]] });
	const b2 = mpc({ op: 'dkg_part2', secret: b1.secret, round1_packages: [[CLIENT, a1.package]] });
	const a3 = mpc({
		op: 'dkg_part3',
		secret: a2.secret,
		round1_packages: [[SERVER, b1.package]],
		round2_packages: [[SERVER, b2.packages.find((x: [number, unknown]) => x[0] === CLIENT)[1]]]
	});
	const b3 = mpc({
		op: 'dkg_part3',
		secret: b2.secret,
		round1_packages: [[CLIENT, a1.package]],
		round2_packages: [[CLIENT, a2.packages.find((x: [number, unknown]) => x[0] === SERVER)[1]]]
	});
	return { client: a3.key_package, server: b3.key_package, pub: a3.public_key_package };
}

const KEYS = dkg();
const VAULT = String(KEYS.client.verifying_key).toLowerCase();
const FULL_SECRET = VaultSecret.pack('vk_live_contract', 7, JSON.stringify(KEYS.client));

/** What the server would disclose for one source; tests override fields to play a lying server. */
interface Plan {
	/** A string on an honest server; anything at all on a lying one. */
	amount: unknown;
	/** The raw asset id the transfer moves. `usdc-base` hashes to USDC@base's fingerprint in assets.json. */
	tokenKey?: string;
	signer?: string;
	/** Hash a different message into the package than the one disclosed. */
	swapMessage?: boolean;
}

const NONCE_HEX = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('hex');
const RECIPIENT = 'recipient.example';

const transferMessage = (p: Plan) =>
	JSON.stringify({
		signer_id: p.signer ?? VAULT,
		deadline: '2026-01-01T00:00:00.000Z',
		intents: [{ intent: 'transfer', receiver_id: 'solver.example', tokens: { [p.tokenKey ?? 'usdc-base']: p.amount } }]
	});

/**
 * A sign/begin that does what the server does: one signing package per client commitment, built over
 * the digest of the disclosed message. The response carries exactly the keys sign_begin.json carries.
 */
function signBegin(plans: Plan[], nonces: unknown[]) {
	const shape = load('sign_begin').response.body;
	return (req: Seen) => {
		const packages: unknown[] = [];
		const messages: unknown[] = [];
		(req.body.commitments as unknown[]).forEach((clientCommit, i) => {
			const plan = plans[i] ?? plans[0]!;
			const message = transferMessage(plan);
			const digest = payloadDigestHex(plan.swapMessage ? `${message} ` : message, Buffer.from(NONCE_HEX, 'hex'), RECIPIENT);
			const mine = mpc({ op: 'commit', key_package: KEYS.server });
			nonces.push(mine.nonces);
			const pkg = mpc({
				op: 'build_signing_package',
				commitments: [
					[CLIENT, clientCommit],
					[SERVER, mine.commitments]
				],
				message_hex: digest
			});
			packages.push(pkg.signing_package);
			messages.push({ message, nonce: NONCE_HEX, recipient: RECIPIENT });
		});
		const body = { token: shape.token, signing_packages: packages, messages };
		assert.deepEqual(Object.keys(body).sort(), Object.keys(shape).sort(), 'same keys as sign_begin.json');
		assert.deepEqual(Object.keys(messages[0] as object).sort(), Object.keys(shape.messages[0]).sort());
		return { status: 200, body };
	};
}

function fullWallet(routes: Record<string, Reply>, pinnedFingerprints?: Record<string, string | string[]>) {
	const s = server(routes);
	return { wallet: new Wallet(FULL_SECRET, { baseUrl: BASE, fetch: s.fetch, pinnedFingerprints }), seen: s.seen };
}

/** How the server fingerprints a raw asset id: lowercase hex SHA-256 of its UTF-8 bytes. */
const sha = (rawId: string) => createHash('sha256').update(rawId, 'utf8').digest('hex');

const find = (seen: Seen[], method: string, pathPrefix: string) =>
	seen.filter((r) => r.method === method && r.path.startsWith(pathPrefix));

/** The quote request the SDK sent carries every field of the fixture's request, and `dry` as told. */
function assertQuoteRequest(sent: Seen, fixture: Fixture, dry: boolean) {
	assert.equal(sent.method, fixture.request.method);
	assert.equal(sent.path, fixture.request.path);
	const { dry: _ignored, ...fields } = fixture.request.body;
	for (const [k, v] of Object.entries(fields)) assert.deepEqual(sent.body[k], v, `request field ${k}`);
	assert.equal(sent.body.dry, dry);
	assert.equal(typeof sent.body.amount, 'string', 'amount is a decimal STRING on the wire');
	if ('slippage_bps' in sent.body) assert.ok(Number.isInteger(sent.body.slippage_bps), 'slippage_bps is an integer');
	const key = sent.headers.get('idempotency-key');
	if (dry) assert.equal(key, null, 'a dry preview carries no Idempotency-Key');
	else assert.ok(key && key.length >= 16, 'a real quote carries an Idempotency-Key');
	assert.equal(sent.headers.get('authorization'), 'Bearer vk_live_contract');
}

/** A quote as the fixture says, field by field — raw strings stay strings, nothing becomes a number. */
function assertQuoteParsed(q: ReturnType<typeof toQuote>, f: Fixture) {
	const b = f.response.body;
	assert.equal(q.movementId, b.movement_id ?? null);
	assert.equal(q.mode, b.mode);
	assert.deepEqual(q.send, b.send);
	assert.deepEqual(q.debit, b.debit);
	assert.deepEqual(q.receive, b.receive);
	assert.deepEqual(q.fees, {
		asset: b.fees.asset,
		platform: b.fees.platform,
		network: b.fees.network,
		route: { amount: b.fees.route.amount, estimate: b.fees.route.estimate },
		total: b.fees.total,
		usd: b.fees.usd
	});
	assert.equal(q.expiresAt, b.expires_at);
	assert.equal(q.sources, b.sources ?? null);
}

// ── the fixture set itself ──────────────────────────────────────────────────

test('the fixtures are on disk and every one of them is served here', () => {
	assert.ok(FIXTURES, 'contract fixtures not found: looked for contract/fixtures and sdk/contract/fixtures above this file');
	const onDisk = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
	assert.deepEqual(onDisk, [...COVERED].sort(), 'a fixture was added or removed: cover it here');
});

// ── reads ───────────────────────────────────────────────────────────────────

test('assets: a bare array, every field', async () => {
	const f = load('assets');
	assert.ok(Array.isArray(f.response.body), 'the server answers a bare array');
	const { wallet, seen } = readWallet(Object.fromEntries([route(f)]));
	const assets = await wallet.assets();
	assert.equal(assets.length, f.response.body.length);
	assert.ok(assets.length > 0, 'not the silent [] the old wrapper read produced');
	assert.deepEqual(
		assets,
		f.response.body.map((a: any) => ({
			asset: a.asset,
			symbol: a.symbol,
			chain: a.chain,
			decimals: a.decimals,
			fingerprint: a.fingerprint
		}))
	);
	for (const a of assets) assert.match(a.fingerprint ?? '', /^[0-9a-f]{64}$/, 'a lowercase sha-256');
	assert.equal(seen[0]!.path, f.request.path);
});

test('assets: an older server without fingerprints still reads', async () => {
	// Derived from assets.json: the same catalogue with `fingerprint` omitted.
	const f = load('assets');
	const bare = f.response.body.map(({ fingerprint: _fp, ...a }: any) => a);
	const { wallet } = readWallet({ [`GET ${f.request.path}`]: { status: 200, body: bare } });
	const assets = await wallet.assets();
	assert.equal(assets.length, bare.length);
	for (const a of assets) assert.equal(a.fingerprint, null);
});

test('assets: the old {assets: [...]} wrapper is refused, not read as an empty catalogue', async () => {
	const f = load('assets');
	const { wallet } = readWallet({ 'GET /vault/v1/assets': { status: 200, body: { assets: f.response.body } } });
	await assert.rejects(wallet.assets(), (e: PaymosError) => e instanceof PaymosError && /not a JSON array/.test(e.message));
});

test('balances: a bare array, every field, usd optional', async () => {
	const f = load('balances');
	const b = f.response.body[0];
	// Derived: the same row with `usd` omitted, which is how the server sends an unpriced balance.
	const { usd: _usd, ...unpriced } = b;
	const { wallet, seen } = readWallet({ [`GET ${f.request.path}`]: { status: 200, body: [b, unpriced] } });
	const [priced, bare] = await wallet.balances();
	assert.deepEqual(priced, {
		asset: b.asset,
		symbol: b.symbol,
		chain: b.chain,
		decimals: b.decimals,
		amountRaw: b.amount_raw,
		usd: b.usd
	});
	assert.equal(bare!.usd, null);
	assert.equal(seen[0]!.path, f.request.path);
});

test('movement: the detail row with its fee breakdown, absent fields as null', async () => {
	const f = load('movement');
	const b = f.response.body;
	const { wallet, seen } = readWallet(Object.fromEntries([route(f)]));
	const mv = await wallet.movement(b.id);
	assert.equal(seen[0]!.path, f.request.path);
	assert.deepEqual(mv, {
		id: b.id,
		type: b.type,
		status: b.status,
		send: b.send,
		receive: b.receive,
		fees: {
			asset: b.fees.asset,
			platform: b.fees.platform,
			network: b.fees.network,
			route: b.fees.route,
			total: b.fees.total,
			usd: b.fees.usd
		},
		destChainTxHash: null,
		destChainExplorerUrl: null,
		createdAt: b.created_at,
		completedAt: null
	});
});

test('movements: a keyset page — items without fees, next_cursor, then an omitted cursor ends it', async () => {
	const f = load('movements_page');
	const b = f.response.body;
	const cursor = b.next_cursor;
	const { wallet, seen } = readWallet({
		...Object.fromEntries([route(f)]),
		// Derived: the last page, on which the server omits next_cursor entirely.
		[`GET /vault/v1/movements?limit=2&cursor=${cursor}`]: { status: 200, body: { items: [] } }
	});
	const page = await wallet.movements(2);
	assert.equal(seen[0]!.path, f.request.path);
	assert.equal(page.nextCursor, cursor);
	assert.equal(page.items.length, b.items.length);
	page.items.forEach((mv, i) => {
		const w = b.items[i];
		assert.deepEqual(mv, {
			id: w.id,
			type: w.type,
			status: w.status,
			send: w.send,
			receive: w.receive,
			fees: null,
			destChainTxHash: null,
			destChainExplorerUrl: null,
			createdAt: w.created_at,
			completedAt: null
		});
	});
	const last = await wallet.movements(2, cursor);
	assert.equal(seen[1]!.path, `/vault/v1/movements?limit=2&cursor=${cursor}`);
	assert.deepEqual(last.items, []);
	assert.equal(last.nextCursor, null);
});

// ── quotes: what is sent, what is read ──────────────────────────────────────

for (const name of ['quote_withdraw_dry', 'quote_withdraw', 'quote_withdraw_total_in', 'quote_swap_dry', 'quote_swap']) {
	test(`${name}: every response field parses`, () => {
		const f = load(name);
		assertQuoteParsed(toQuote(f.response.body), f);
	});
}

test('quote_withdraw_dry: quoteWithdraw sends exactly the fixture request', async () => {
	const f = load('quote_withdraw_dry');
	const r = f.request.body;
	const { wallet, seen } = readWallet(Object.fromEntries([route(load('assets')), route(f)]));
	const q = await wallet.quoteWithdraw(r.asset, r.amount, r.to, r.mode);
	const sent = find(seen, 'POST', f.request.path)[0]!;
	assert.deepEqual(sent.body, r, 'the whole body, dry:true included');
	assertQuoteRequest(sent, f, true);
	assertQuoteParsed(q, f);
	assert.equal(q.movementId, null, 'a dry preview creates nothing');
});

test('quote_swap_dry: quoteSwap sends exactly the fixture request', async () => {
	const f = load('quote_swap_dry');
	const r = f.request.body;
	const { wallet, seen } = readWallet(Object.fromEntries([route(load('assets')), route(f)]));
	const q = await wallet.quoteSwap(r.send, r.receive, r.amount, r.slippage_bps);
	const sent = find(seen, 'POST', f.request.path)[0]!;
	assert.deepEqual(sent.body, r);
	assertQuoteRequest(sent, f, true);
	assertQuoteParsed(q, f);
});

test('quote_withdraw: withdraw sends the fixture request with an Idempotency-Key, then commits once per source', async () => {
	const f = load('quote_withdraw');
	const r = f.request.body;
	const begin = load('sign_begin');
	const { wallet, seen } = fullWallet({
		...Object.fromEntries([route(load('assets')), route(f)]),
		// The fixture's sign/begin: ONE package, for a quote that has TWO sources.
		[`POST /vault/v1/movements/${f.response.body.movement_id}/sign/begin`]: begin.response
	});
	await assert.rejects(wallet.withdraw(r.asset, r.amount, r.to, { mode: r.mode }), /expected 2 signing packages, got 1/);
	assertQuoteRequest(find(seen, 'POST', f.request.path)[0]!, f, false);
	const commitments = find(seen, 'POST', '/vault/v1/movements/')[0]!.body.commitments;
	assert.equal(commitments.length, f.response.body.sources, 'one commitment per source');
	for (const c of commitments) assert.ok(c.hiding && c.binding, 'a commitment carries hiding and binding');
	assert.equal(find(seen, 'POST', '/vault/v1/movements/mv_1/sign/aggregate').length, 0, 'nothing was signed');
});

test('quote_withdraw_total_in: withdraw(total_in) sends the fixture request and accepts a debit at the total', async () => {
	const f = load('quote_withdraw_total_in');
	const r = f.request.body;
	const { wallet, seen } = fullWallet({
		...Object.fromEntries([route(load('assets')), route(f)]),
		[`POST /vault/v1/movements/${f.response.body.movement_id}/sign/begin`]: load('sign_begin').response
	});
	// Past the echo check (debit == the typed total) and into the co-sign, where the one-package
	// fixture fails the two-source count — which is the proof the echo check let it through.
	await assert.rejects(wallet.withdraw(r.asset, r.amount, r.to, { mode: 'total_in' }), /expected 2 signing packages/);
	assertQuoteRequest(find(seen, 'POST', f.request.path)[0]!, f, false);
});

test('quote_swap: swap sends the fixture request, and the fixture sign/begin placeholders are refused, not signed', async () => {
	const f = load('quote_swap');
	const r = f.request.body;
	const { wallet, seen } = fullWallet({
		...Object.fromEntries([route(load('assets')), route(f)]),
		[`POST /vault/v1/movements/${f.response.body.movement_id}/sign/begin`]: load('sign_begin').response
	});
	// sign_begin.json parses (token, one package for one source, messages) and its placeholder
	// disclosure — a 2-byte nonce, a package that binds to nothing — stops the round.
	await assert.rejects(
		wallet.swap(r.send, r.receive, r.amount, { slippageBps: r.slippage_bps }),
		(e: PaymosError) => e instanceof PaymosError && /co-sign refused/.test(e.message)
	);
	assertQuoteRequest(find(seen, 'POST', f.request.path)[0]!, f, false);
	assert.equal(find(seen, 'POST', '/vault/v1/movements/mv_3/sign/begin')[0]!.body.commitments.length, 1);
	assert.equal(find(seen, 'POST', '/vault/v1/movements/mv_3/sign/aggregate').length, 0, 'nothing was signed');
});

test('echo check: an exact_out quote paying out more than approved is refused before any commitment', async () => {
	// Derived from quote_withdraw.json: a server answering "10" with a payout of 1000 — receive and
	// min both inflated, so a min-at-or-above check passes it. Only an exact receive check does not.
	const f = load('quote_withdraw');
	const b = f.response.body;
	const inflated = (BigInt(b.receive.amount) * 100n).toString();
	const lying = { ...b, receive: { ...b.receive, amount: inflated, min: inflated }, debit: { ...b.debit, amount: inflated } };
	const { wallet, seen } = fullWallet({
		...Object.fromEntries([route(load('assets'))]),
		[`POST ${f.request.path}`]: { status: 200, body: lying }
	});
	const r = f.request.body;
	await assert.rejects(wallet.withdraw(r.asset, r.amount, r.to), /not the approved/);
	assert.equal(find(seen, 'POST', '/vault/v1/movements/').length, 0, 'no commitment left the process');
});

// ── the co-sign round ───────────────────────────────────────────────────────

/** A swap over quote_swap.json with a sign/begin that behaves (or lies) as `plans` say. */
interface RoundOptions {
	/** A catalogue derived from assets.json, served in its place. */
	assets?: unknown[];
	pins?: Record<string, string | string[]>;
}

function swapRound(
	plans: Plan[],
	aggregate: { status: number; body: unknown },
	movement = load('movement'),
	opts: RoundOptions = {}
) {
	const q = load('quote_swap');
	const mid = q.response.body.movement_id;
	const serverNonces: unknown[] = [];
	let signingPackages: any[] = [];
	const begin = signBegin(plans, serverNonces);
	const a = load('assets');
	const { wallet, seen } = fullWallet({
		...Object.fromEntries([route(q), route(movement)]),
		[`GET ${a.request.path}`]: { status: 200, body: opts.assets ?? a.response.body },
		[`POST /vault/v1/movements/${mid}/sign/begin`]: (req) => {
			const res = begin(req);
			signingPackages = (res.body as { signing_packages: any[] }).signing_packages;
			return res;
		},
		[`POST /vault/v1/movements/${mid}/sign/aggregate`]: (req) => {
			assert.equal(req.body.token, load('sign_begin').response.body.token, 'the token from sign/begin comes back');
			// Play the server: its own share, then aggregate — the client's share must complete it.
			const verified = signingPackages.every((pkg, i) => {
				const mine = mpc({ op: 'sign', signing_package: pkg, nonces: serverNonces[i], key_package: KEYS.server });
				const agg = mpc({
					op: 'aggregate',
					signing_package: pkg,
					signature_shares: [
						[CLIENT, req.body.shares[i]],
						[SERVER, mine.signature_share]
					],
					public_key_package: KEYS.pub
				});
				return agg.verified === true;
			});
			assert.ok(verified, 'the SDK signed exactly the package it was sent');
			return aggregate;
		}
	}, opts.pins);
	const r = q.request.body;
	return { run: () => wallet.swap(r.send, r.receive, r.amount, { slippageBps: r.slippage_bps }), seen, mid };
}

const AMOUNT = load('quote_swap').response.body.debit.amount;

test('sign_aggregate: an honest round signs, aggregates, and returns the movement', async () => {
	const { run, seen, mid } = swapRound([{ amount: AMOUNT }], load('sign_aggregate').response);
	const mv = await run();
	assert.equal(mv.id, mid);
	assert.equal(find(seen, 'POST', `/vault/v1/movements/${mid}/sign/aggregate`).length, 1);
});

test('sign_aggregate_error: a 400 ok:false surfaces as a typed error with the server message', async () => {
	const f = load('sign_aggregate_error');
	const { run } = swapRound([{ amount: AMOUNT }], f.response);
	await assert.rejects(run(), (e: PaymosError) =>
		e instanceof PaymosError && e.status === 400 && e.message === f.response.body.error
	);
});

test('sign_aggregate: a 2xx that still says ok:false is a failure, never a success', async () => {
	// Derived from sign_aggregate_error.json: the same envelope with a 200.
	const f = load('sign_aggregate_error');
	const { run } = swapRound([{ amount: AMOUNT }], { status: 200, body: f.response.body });
	await assert.rejects(run(), (e: PaymosError) => e instanceof PaymosError && e.message === f.response.body.error);
});

test('blind-sign guard: a package over a different message than the one disclosed is refused', async () => {
	const { run, seen, mid } = swapRound([{ amount: AMOUNT, swapMessage: true }], load('sign_aggregate').response);
	await assert.rejects(run(), /does not bind to the disclosed message/);
	assert.equal(find(seen, 'POST', `/vault/v1/movements/${mid}/sign/aggregate`).length, 0);
});

test('blind-sign guard: a transfer signed from another vault is refused', async () => {
	const { run } = swapRound([{ amount: AMOUNT, signer: 'f'.repeat(64) }], load('sign_aggregate').response);
	await assert.rejects(run(), /signs from a different vault/);
});

test('blind-sign guard: a transfer larger than the approved debit is refused', async () => {
	const { run } = swapRound([{ amount: (BigInt(AMOUNT) + 1n).toString() }], load('sign_aggregate').response);
	await assert.rejects(run(), /above the approved debit/);
});

test('blind-sign guard: a transfer of another asset is refused, even at the approved amount', async () => {
	// `usdt-base` hashes to USDT@base's fingerprint — a real catalogue asset, just not the send one.
	const { run, seen, mid } = swapRound([{ amount: AMOUNT, tokenKey: 'usdt-base' }], load('sign_aggregate').response);
	await assert.rejects(run(), /source 0 moves a different asset than USDC@base/);
	assert.equal(find(seen, 'POST', `/vault/v1/movements/${mid}/sign/aggregate`).length, 0);
});

test('blind-sign guard: every per-source amount is ASCII digits and above zero', async () => {
	for (const amount of ['0', '00', '-1', '+5', '', ' 5', '5 ', '0x10', '1e3', '٥', 5, null]) {
		const { run, seen, mid } = swapRound([{ amount }], load('sign_aggregate').response);
		await assert.rejects(run(), /bad transfer amount for source 0/, `amount ${JSON.stringify(amount)}`);
		assert.equal(find(seen, 'POST', `/vault/v1/movements/${mid}/sign/aggregate`).length, 0);
	}
});

test('co-sign: a send asset with no published fingerprint refuses before any commitment', async () => {
	// Derived from assets.json with `fingerprint` omitted: an older server. The check is not skipped.
	const a = load('assets');
	const bare = a.response.body.map(({ fingerprint: _fp, ...x }: any) => x);
	const q = load('quote_swap');
	const { wallet, seen } = fullWallet({
		[`GET ${a.request.path}`]: { status: 200, body: bare },
		...Object.fromEntries([route(q)])
	});
	const r = q.request.body;
	await assert.rejects(
		wallet.swap(r.send, r.receive, r.amount),
		/co-sign refused: the server did not publish an asset fingerprint — update the server/
	);
	assert.equal(find(seen, 'POST', '/vault/v1/movements/').length, 0);
});

test('co-sign: a key package without verifying_key refuses instead of skipping the signer check', async () => {
	const { verifying_key: _vk, ...headless } = KEYS.client;
	const q = load('quote_swap');
	const s = server(Object.fromEntries([route(load('assets')), route(q)]));
	const wallet = new Wallet(VaultSecret.pack('vk_live_contract', 7, JSON.stringify(headless)), { baseUrl: BASE, fetch: s.fetch });
	const r = q.request.body;
	await assert.rejects(wallet.swap(r.send, r.receive, r.amount), /no verifying_key/);
	assert.equal(find(s.seen, 'POST', '/vault/v1/movements/').length, 0);
});

// ── one label, several fingerprints; and fingerprints pinned by the caller ──

/**
 * Derived from assets.json: USDC@base listed twice, a second contract of the same coin after the
 * first — the server resolves a label to its FIRST match, and a map keyed by label keeps the LAST.
 */
const TWO_CONTRACTS = (() => {
	const body = load('assets').response.body as any[];
	const usdc = body.find((x) => x.asset === 'USDC@base');
	return [...body, { ...usdc, fingerprint: sha('usdc-base-bridged') }];
})();

test('one label, two fingerprints, EQUAL decimals: a token matching either one signs', async () => {
	for (const tokenKey of ['usdc-base', 'usdc-base-bridged']) {
		const { run, seen, mid } = swapRound([{ amount: AMOUNT, tokenKey }], load('sign_aggregate').response, undefined, {
			assets: TWO_CONTRACTS
		});
		const mv = await run();
		assert.equal(mv.id, mid, tokenKey);
		assert.equal(find(seen, 'POST', `/vault/v1/movements/${mid}/sign/aggregate`).length, 1, tokenKey);
	}
});

test('one label, two fingerprints: a token matching neither is refused', async () => {
	const { run, seen, mid } = swapRound([{ amount: AMOUNT, tokenKey: 'usdt-base' }], load('sign_aggregate').response, undefined, {
		assets: TWO_CONTRACTS
	});
	await assert.rejects(run(), /moves a different asset than USDC@base/);
	assert.equal(find(seen, 'POST', `/vault/v1/movements/${mid}/sign/aggregate`).length, 0);
});

test('one label, two entries with DIFFERENT decimals: the second entry\'s token is refused before any share', async () => {
	// Derived from assets.json: USDC@base again, another contract, with 18 decimals. The debit is in
	// the first entry's 6-decimal units, so a raw amount under it in the 18-decimal token means
	// nothing — that entry's fingerprint is not accepted. The first entry's token still signs.
	const body = load('assets').response.body as any[];
	const usdc = body.find((x) => x.asset === 'USDC@base');
	const catalogue = [...body, { ...usdc, decimals: 18, fingerprint: sha('usdc-base-18') }];
	const refused = swapRound([{ amount: AMOUNT, tokenKey: 'usdc-base-18' }], load('sign_aggregate').response, undefined, {
		assets: catalogue
	});
	await assert.rejects(refused.run(), /moves a different asset than USDC@base/);
	assert.equal(find(refused.seen, 'POST', `/vault/v1/movements/${refused.mid}/sign/aggregate`).length, 0);
	const honest = swapRound([{ amount: AMOUNT, tokenKey: 'usdc-base' }], load('sign_aggregate').response, undefined, {
		assets: catalogue
	});
	assert.equal((await honest.run()).id, honest.mid);
});

test('one label listed twice: decimals come from the FIRST entry, as the server resolves it', async () => {
	// Derived from assets.json: USDC@base again after the original, with 18 decimals instead of 6.
	const a = load('assets');
	const body = a.response.body as any[];
	const catalogue = [...body, { ...body.find((x) => x.asset === 'USDC@base'), decimals: 18 }];
	const q = load('quote_withdraw');
	const r = q.request.body;
	const { wallet, seen } = fullWallet({
		[`GET ${a.request.path}`]: { status: 200, body: catalogue },
		...Object.fromEntries([route(q)]),
		[`POST /vault/v1/movements/${q.response.body.movement_id}/sign/begin`]: load('sign_begin').response
	});
	// Amount conversion: 7 fractional digits fit 18 decimals, not 6 — refused before any request.
	await assert.rejects(wallet.quoteWithdraw(r.asset, '10.1234567', r.to), /more than 6 fractional digits/);
	assert.equal(find(seen, 'POST', q.request.path).length, 0);
	// Echo check: "10" is 10000000 at 6 decimals, which is what quote_withdraw.json receives. With the
	// last entry's 18 it would be 10^19 and refused; instead it passes into the co-sign, where the
	// one-package sign_begin.json fails the two-source count.
	await assert.rejects(wallet.withdraw(r.asset, r.amount, r.to), /expected 2 signing packages/);
});

test('pinnedFingerprints: a pinned match signs, whatever /assets publishes for that label', async () => {
	// Derived: the server publishes a DIFFERENT USDC@base fingerprint than the token hashes to. The
	// pin — uppercase, and as a list, to prove both are accepted — is what the guard trusts.
	const other = (load('assets').response.body as any[]).map((x) =>
		x.asset === 'USDC@base' ? { ...x, fingerprint: sha('something-else') } : x
	);
	const { run, seen, mid } = swapRound([{ amount: AMOUNT, tokenKey: 'usdc-base' }], load('sign_aggregate').response, undefined, {
		assets: other,
		pins: { 'USDC@base': [sha('usdc-base').toUpperCase()] }
	});
	assert.equal((await run()).id, mid);
	assert.equal(find(seen, 'POST', `/vault/v1/movements/${mid}/sign/aggregate`).length, 1);
});

test('pinnedFingerprints: a server fingerprint that differs from the pin is refused', async () => {
	// assets.json publishes sha("usdc-base") and the token matches it; the caller pinned another value.
	const { run, seen, mid } = swapRound([{ amount: AMOUNT, tokenKey: 'usdc-base' }], load('sign_aggregate').response, undefined, {
		pins: { 'USDC@base': sha('usdc-base-pinned') }
	});
	await assert.rejects(run(), /moves a different asset than USDC@base/);
	assert.equal(find(seen, 'POST', `/vault/v1/movements/${mid}/sign/aggregate`).length, 0);
});

test('pinnedFingerprints: a pin that is not a sha-256 fails at construction', () => {
	for (const bad of ['', 'abc', [], ['z'.repeat(64)]]) {
		assert.throws(
			() => new Wallet(FULL_SECRET, { pinnedFingerprints: { 'USDC@base': bad as never } }),
			(e: PaymosError) => e instanceof PaymosError && /pinnedFingerprints\[USDC@base\]/.test(e.message)
		);
	}
});

test('blind-sign guard: a negative source cannot hide an oversized one from the debit check', async () => {
	// quote_withdraw has two sources and a debit of D. Source 0 moves 2D, source 1 claims -D: the
	// sum is D and passes check (3), but source 0 alone is twice what was approved.
	const q = load('quote_withdraw');
	const debit = BigInt(q.response.body.debit.amount);
	const nonces: unknown[] = [];
	const { wallet, seen } = fullWallet({
		...Object.fromEntries([route(load('assets')), route(q)]),
		[`POST /vault/v1/movements/${q.response.body.movement_id}/sign/begin`]: signBegin(
			[{ amount: (2n * debit).toString() }, { amount: (-debit).toString() }],
			nonces
		)
	});
	const r = q.request.body;
	await assert.rejects(wallet.withdraw(r.asset, r.amount, r.to), /bad transfer amount for source 1/);
	assert.equal(find(seen, 'POST', '/vault/v1/movements/mv_1/sign/aggregate').length, 0);
});

test('blind-sign guard: no disclosure, no signature', async () => {
	const q = load('quote_swap');
	const { messages: _m, ...undisclosed } = load('sign_begin').response.body;
	const { wallet } = fullWallet({
		...Object.fromEntries([route(load('assets')), route(q)]),
		[`POST /vault/v1/movements/mv_3/sign/begin`]: { status: 200, body: undisclosed }
	});
	const r = q.request.body;
	await assert.rejects(wallet.swap(r.send, r.receive, r.amount), /refusing to blind-sign/);
});

// ── sign/begin failures and idempotent-retry convergence ────────────────────

function beginFails(status: string) {
	const q = load('quote_swap');
	const mv = load('movement');
	const { wallet, seen } = fullWallet({
		...Object.fromEntries([route(load('assets')), route(q), route(load('sign_begin_error'))]),
		// Derived from movement.json: the same movement in the status under test.
		[`GET ${mv.request.path}`]: { status: 200, body: { ...mv.response.body, status } }
	});
	const r = q.request.body;
	return { run: () => wallet.swap(r.send, r.receive, r.amount), seen };
}

test('sign_begin_error: on a still-pending movement the typed error propagates', async () => {
	const f = load('sign_begin_error');
	const { run } = beginFails('pending');
	await assert.rejects(run(), (e: PaymosError) =>
		e instanceof PaymosError && e.status === 400 && e.message === f.response.body.error
	);
});

test('sign_begin_error: a movement a prior attempt already progressed converges instead of re-signing', async () => {
	for (const status of PROGRESSED) {
		const { run, seen } = beginFails(status);
		const mv = await run();
		assert.equal(mv.status, status);
		assert.equal(find(seen, 'POST', '/vault/v1/movements/mv_3/sign/aggregate').length, 0);
	}
});

test('sign_begin_error: a failed movement is not "already signed" — the error propagates', async () => {
	const { run } = beginFails('failed');
	await assert.rejects(run(), /commitments are required/);
});

// ── errors ──────────────────────────────────────────────────────────────────

const isExactly = (type: Function, status: number, message: string) => (e: PaymosError) =>
	e.constructor === type && e.status === status && e.message === message;

test('error_401: AuthError with the server message', async () => {
	const f = load('error_401');
	const { wallet } = readWallet(Object.fromEntries([route(f)]));
	await assert.rejects(wallet.balances(), isExactly(AuthError, 401, f.response.body.error));
});

test('error_403: Forbidden with the server message', async () => {
	const f = load('error_403');
	const r = f.request.body;
	const { wallet, seen } = readWallet(Object.fromEntries([route(load('assets')), route(f)]));
	await assert.rejects(wallet.quoteWithdraw(r.asset, r.amount, r.to, r.mode), isExactly(Forbidden, 403, f.response.body.error));
	assertQuoteRequest(find(seen, 'POST', f.request.path)[0]!, f, true);
});

test('error_400: an invalid mode is the base PaymosError with the server message', async () => {
	const f = load('error_400');
	const r = f.request.body;
	const { wallet, seen } = readWallet(Object.fromEntries([route(load('assets')), route(f)]));
	await assert.rejects(wallet.quoteWithdraw(r.asset, r.amount, r.to, r.mode), isExactly(PaymosError, 400, f.response.body.error));
	assert.equal(find(seen, 'POST', f.request.path)[0]!.body.mode, 'exact-out', 'the mode is sent verbatim, not "fixed"');
});

test('error_400_body: a rejected body is the base PaymosError with the server message', async () => {
	const f = load('error_400_body');
	const s = server(Object.fromEntries([route(f)]));
	const http = new Http(BASE, 'vk_live_contract', { fetch: s.fetch });
	await assert.rejects(http.post(f.request.path, {}), isExactly(PaymosError, 400, f.response.body.error));
});

test('error_404_movement: the base PaymosError, status 404', async () => {
	const f = load('error_404_movement');
	const { wallet } = readWallet(Object.fromEntries([route(f)]));
	await assert.rejects(wallet.movement('does-not-exist'), isExactly(PaymosError, 404, f.response.body.error));
});

test('error_404_path: the base PaymosError, status 404', async () => {
	const f = load('error_404_path');
	const s = server(Object.fromEntries([route(f)]));
	const http = new Http(BASE, 'vk_live_contract', { fetch: s.fetch });
	await assert.rejects(http.get(f.request.path), isExactly(PaymosError, 404, f.response.body.error));
});

test('error_409_idempotency: Conflict, and nothing is signed', async () => {
	const f = load('error_409_idempotency');
	const r = f.request.body;
	const { wallet, seen } = fullWallet(Object.fromEntries([route(load('assets')), route(f)]));
	await assert.rejects(wallet.withdraw(r.asset, r.amount, r.to, { mode: r.mode }), isExactly(Conflict, 409, f.response.body.error));
	assertQuoteRequest(find(seen, 'POST', f.request.path)[0]!, f, false);
	assert.equal(find(seen, 'POST', '/vault/v1/movements/').length, 0);
});

test('a proxy HTML 404 on the wallet path is a typed error, not a parse exception', async () => {
	const html = '<!DOCTYPE html><html><head><title>404</title></head><body>Not Found</body></html>';
	const { wallet } = readWallet({ 'GET /vault/v1/assets': { status: 404, body: html, raw: true } });
	await assert.rejects(wallet.assets(), (e: PaymosError) =>
		e instanceof PaymosError && e.status === 404 && /HTML page/.test(e.message) && !e.message.includes('<')
	);
});

test('an HTML page answering 200 on the wallet path is a typed error too', async () => {
	const html = '<!DOCTYPE html><html><body>Private Wallet</body></html>';
	const { wallet } = readWallet({ 'GET /vault/v1/balances': { status: 200, body: html, raw: true } });
	await assert.rejects(wallet.balances(), (e: PaymosError) => e instanceof PaymosError && e.status === 200);
});

// ── vocabulary ──────────────────────────────────────────────────────────────

// Python's sets, verbatim (sdk/python/paymos/_wallet.py). The reference implementation.
const PY_TERMINAL = new Set(['completed', 'failed', 'refunded', 'expired', 'cancelled']);
const PY_PROGRESSED = new Set(['processing', 'completed', 'refunded']);

test('vocabulary: every status the server sends is classified as Python classifies it', () => {
	const v = load('vocabulary') as unknown as { movement_statuses: string[]; sign_statuses: string[] };
	for (const status of v.movement_statuses) {
		assert.equal(TERMINAL.has(status), PY_TERMINAL.has(status), `terminal(${status})`);
		assert.equal(PROGRESSED.has(status), PY_PROGRESSED.has(status), `progressed(${status})`);
	}
	// And no word the server never sends: a set entry outside the vocabulary can never match.
	for (const status of [...TERMINAL, ...PROGRESSED]) {
		assert.ok(v.movement_statuses.includes(status), `${status} is not a status the server sends`);
	}
	assert.deepEqual([...TERMINAL].sort(), [...PY_TERMINAL].sort());
	assert.deepEqual([...PROGRESSED].sort(), [...PY_PROGRESSED].sort());
	// sign/aggregate answers a sign status; the success fixture's must be one the vocabulary has.
	assert.ok(v.sign_statuses.includes(load('sign_aggregate').response.body.status));
	assert.ok(v.sign_statuses.includes(load('sign_aggregate_error').response.body.status));
});

test('vocabulary: wait() stops on exactly the terminal statuses', async () => {
	const v = load('vocabulary') as unknown as { movement_statuses: string[] };
	const f = load('movement');
	for (const status of v.movement_statuses) {
		const { wallet } = readWallet({ [`GET ${f.request.path}`]: { status: 200, body: { ...f.response.body, status } } });
		const waited = wallet.wait(f.response.body.id, { timeoutMs: 5, intervalMs: 1 });
		if (PY_TERMINAL.has(status)) assert.equal((await waited).status, status);
		else await assert.rejects(waited, /timed out/);
	}
});

// ── base URL ────────────────────────────────────────────────────────────────

test('base URL: wallet.paymos.io by default, PAYMOS_BASE_URL overrides it', async () => {
	const f = load('assets');
	const saved = process.env.PAYMOS_BASE_URL;
	const urls: string[] = [];
	const fetch = (async (u: unknown) => {
		urls.push(String(u));
		return new Response(JSON.stringify(f.response.body), { status: 200 });
	}) as typeof globalThis.fetch;
	try {
		delete process.env.PAYMOS_BASE_URL;
		await new Wallet(READ_SECRET, { fetch }).assets();
		process.env.PAYMOS_BASE_URL = 'https://staging.example/';
		await new Wallet(READ_SECRET, { fetch }).assets();
		process.env.PAYMOS_BASE_URL = '';
		await new Wallet(READ_SECRET, { fetch }).assets();
	} finally {
		if (saved === undefined) delete process.env.PAYMOS_BASE_URL;
		else process.env.PAYMOS_BASE_URL = saved;
	}
	assert.deepEqual(urls, [
		'https://wallet.paymos.io/vault/v1/assets',
		'https://staging.example/vault/v1/assets',
		'https://wallet.paymos.io/vault/v1/assets'
	]);
});
