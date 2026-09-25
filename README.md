# @paymos/wallet

Send, swap and bridge **USDT, USDC, BTC, ETH** and the rest of the wallet's catalogue from
Node.js and TypeScript — no browser, no wallet extension, and no seed phrase anywhere in your environment. It is
built for the services that pay people out: marketplaces, exchanges, payroll and treasury jobs.

Your process holds **one half** of the signing key; the server holds the other. **Neither side alone
can move funds** — every swap and withdrawal is co-signed, and your half never reaches the server.

- **Non-custodial** — a leaked API key cannot sign. Your co-signing share stays in your process.
- **Fee-transparent** — every quote is a dry preview with a full `platform / network / route`
  breakdown you see *before* signing anything.
- **Never blind-signs** — the server discloses each message it wants signed; this SDK recomputes the
  digest and refuses unless the package binds to exactly that message, from your vault, for no more
  than the quote's debit, moving a token that matches the send asset's fingerprint. What it does not
  check is below.

```bash
npm install @paymos/wallet
```

```ts
import { Wallet, formatUnits } from '@paymos/wallet';

const wallet = Wallet.fromEnv(); // reads PAYMOS_VAULT_SECRET

for (const b of await wallet.balances()) {
  console.log(b.symbol, formatUnits(b.amountRaw, b.decimals));
}

// A preview. Nothing is created and nothing is signed.
const quote = await wallet.quoteSwap('USDT@tron', 'USDC@base', '100');
console.log(quote.receive.amount, 'quoted, at least', quote.receive.min);

// The real thing, with a floor and a ceiling you choose.
const movement = await wallet.swap('USDT@tron', 'USDC@base', '100', {
  minReceive: '99.5',
  maxDebit: '100.5',
  idempotencyKey: myJobId   // a retry replays the same movement instead of paying twice
});
console.log(movement.status);
```

## Keys

The secret is a `vs_live_…` string carrying an API key, the vault id, and — for a full key — your
co-signing share. A **read** key can list assets, balances, movements and quotes. A **full** key can
also `swap` and `withdraw`, and it is the only kind that can sign.

`VaultSecret` never renders the share and masks the key, so a stray `console.log` or a stack trace
cannot carry a usable credential.

## Amounts

Every amount is a **string of raw integer units**, never a number. A token with 18 decimals runs past
what a double holds exactly, so a number here would round somebody's balance silently. Use
`parseUnits('1.5', 6)` to build one and `formatUnits(raw, 6)` to show one.

## Errors

Branch on the type rather than the message: `AuthError`, `Forbidden`, `InsufficientFunds`,
`QuoteExpired`, `SlippageExceeded`, `CrossAssetWithdrawNotAllowed`, `RouteUnavailable`,
`RateLimited` (carries `retryAfter`), `Conflict`, and `PaymosError` as the base.

## From a source checkout

The co-signing core is WebAssembly, built from the same Rust crate the Python SDK and the server
use — nobody reimplements the signing.

```bash
npm run build:wasm   # needs: cargo install wasm-pack
npm run build
npm test
```

---

## FAQ

### How do I send USDT (TRC20) from code?

Install the SDK, point it at your vault, and ask for a withdrawal with the asset written the way the
wallet writes it — `USDT@tron`. The same call sends USDT on BNB Chain (`USDT@bsc`), Ethereum
(`USDT@eth`), Polygon, Solana, Arbitrum, Avalanche or TON: the asset string is the only difference.

```
npm install @paymos/wallet
```

### Is this custodial? Who can move the money?

Nobody alone. The vault is **2-of-2**: your process holds one signing share, the server holds the
other, and a transfer needs both. A stolen API key cannot sign, and the server cannot sign without
you. Your share never leaves your process.

### What is the difference between a quote and a transfer?

A quote is a dry run. It prices the route, separates platform, network and route fees, and reserves
nothing — ask for as many as you like. A transfer is the same numbers, signed. Nothing moves until
your half of the signature exists.

### Does it blind-sign whatever the server asks for?

No, and this is the part worth reading twice. The server discloses the exact message it wants
signed; the SDK recomputes the digest itself and refuses unless that message belongs to your vault,
moves no more than the quote's debit, and the quote matches the request you made.

Know the limits. The recipient of each transfer is the route's deposit address, chosen by the
server, and the SDK does not check it. "No more than the debit" is bounded by the quote's debit,
and for an `exact_out` withdraw that debit is computed by the server — pass `maxDebit` to make it
your number; for any unattended payout, do.

The token each transfer moves is checked too: its hash must match the send asset's `fingerprint`
from `assets()`. That fingerprint is published by the same server that builds the messages, so it
catches a server bug or a compromised signing path, not a server that lies in both places. For a
trust anchor independent of the server, pin the fingerprints yourself —
`new Wallet(secret, { pinnedFingerprints: { 'USDC@base': '<sha-256 hex>' } })` (a string or a list
per label). A pinned label is checked against only your values; the others use what the server
publishes.

### Which networks and assets are supported?

USDT moves on nine chains — Tron, Ethereum, BNB Chain, Polygon, Solana, Arbitrum, Optimism,
Avalanche and TON — and USDC on eight: that same list without Tron and TON, with Base instead. Add
the native coin of each of those chains, and BTC, LTC, DOGE, XRP, BCH, DASH, ZEC and ADA, and the
catalogue is 21 assets across 18 chains. It is also the authority: an asset it does not list cannot
be quoted or sent, in any SDK.

### How are fees reported?

Every quote breaks the cost into platform, network and route, and amounts come back as raw integer
strings rather than floats: money that has been through a float is money with a rounding error in
it. You pass human amounts in (`"100"`, `"0.5"`) and read exact integers back.

### Can I use it for automated payouts?

That is what it is for: headless, no browser, no wallet extension, no seed phrase in the environment.
A worker holding one share can pay out continuously, and losing that machine costs the ability to
sign — not the funds.

### What happens if a transfer is interrupted?

Every money-moving call takes an idempotency key. Repeating a call with the same key returns the
original operation instead of starting a second one, so a retry after a timeout cannot pay twice.

## The same wallet, in eight languages

Every SDK here speaks to the same vault API and enforces the same rules; pick the one your service is
written in. The signing core is shared, so a fix there reaches all of them.

| Language | Package | Repository |
|---|---|---|
| Python | `pip install paymos-wallet` | [python-wallet-sdk](https://github.com/paymos-labs/python-wallet-sdk) |
| TypeScript / Node.js *(this one)* | `npm install @paymos/wallet` | [typescript-wallet-sdk](https://github.com/paymos-labs/typescript-wallet-sdk) |
| Go | `go get github.com/paymos-labs/go-wallet-sdk` | [go-wallet-sdk](https://github.com/paymos-labs/go-wallet-sdk) |
| Rust | `cargo add paymos-wallet` | [rust-wallet-sdk](https://github.com/paymos-labs/rust-wallet-sdk) |
| C# / .NET | `dotnet add package Paymos.Wallet` | [csharp-wallet-sdk](https://github.com/paymos-labs/csharp-wallet-sdk) |
| Java | `io.paymos:wallet` | [java-wallet-sdk](https://github.com/paymos-labs/java-wallet-sdk) |
| Ruby | `gem install paymos-wallet` | [ruby-wallet-sdk](https://github.com/paymos-labs/ruby-wallet-sdk) |
| PHP | `composer require paymos/wallet` | [php-wallet-sdk](https://github.com/paymos-labs/php-wallet-sdk) |
| Signing core | `paymos-wallet-core` | [paymos-wallet-core](https://github.com/paymos-labs/paymos-wallet-core) |

## Documentation

- [wallet.paymos.io](https://wallet.paymos.io) — the product, the supported networks, and guides for
  the routes people ask about most: USDT BEP20 to TRC20, USDC between chains, and the rest.
- [Networks and assets](https://wallet.paymos.io/networks) — every chain and token the wallet
  carries, with the standard each one is named by.
- [USDT BEP20 → TRC20](https://wallet.paymos.io/guides/usdt-bep20-to-trc20) — a worked route, priced
  live; the other pairs are linked from it.
