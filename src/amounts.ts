/**
 * Human decimal ↔ raw integer, ported from the Python SDK.
 *
 * Raw amounts are strings rather than numbers on purpose. A token with 18 decimals overflows the
 * exact range of an IEEE double at nine significant digits of whole units, so `Number` would round
 * silently — the one failure nobody notices until it is somebody's balance.
 */

const DECIMAL = /^\d+(\.\d+)?$/;

/** `"1.5"`, 6 → `"1500000"`. Rejects anything that is not a non-negative decimal. */
export function parseUnits(human: string, decimals: number): string {
	if (decimals < 0) throw new RangeError('decimals must be >= 0');
	const s = (human ?? '').trim();
	if (!DECIMAL.test(s)) throw new RangeError(`not a non-negative decimal: ${JSON.stringify(human)}`);
	const [whole, frac = ''] = s.split('.');
	if (frac.length > decimals) {
		throw new RangeError(`more than ${decimals} fractional digits: ${JSON.stringify(human)}`);
	}
	const padded = frac.padEnd(decimals, '0');
	// BigInt, not Number: the string may be longer than a double can hold exactly.
	return (BigInt(whole + padded) || 0n).toString();
}

/** `"1500000"`, 6 → `"1.5"`. Trailing zeros in the fraction are dropped. */
export function formatUnits(raw: string, decimals: number): string {
	const n = BigInt(raw);
	const sign = n < 0n ? '-' : '';
	const abs = (n < 0n ? -n : n).toString();
	if (decimals === 0) return `${sign}${abs}`;
	const s = abs.padStart(decimals + 1, '0');
	const whole = s.slice(0, -decimals);
	const frac = s.slice(-decimals).replace(/0+$/, '');
	return frac ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}
