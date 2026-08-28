import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { formatUnits, parseUnits } from '../dist/amounts.js';

test('parses human decimals into raw units', () => {
	assert.equal(parseUnits('1.5', 6), '1500000');
	assert.equal(parseUnits('1', 6), '1000000');
	assert.equal(parseUnits('0.000001', 6), '1');
	assert.equal(parseUnits('12', 0), '12');
});

test('rejects anything that is not a non-negative decimal', () => {
	for (const bad of ['-1', 'abc', '', '1,5', '1.2.3', ' ']) {
		assert.throws(() => parseUnits(bad, 6), RangeError, `should reject ${JSON.stringify(bad)}`);
	}
	assert.throws(() => parseUnits('1.1234567', 6), RangeError, 'too many fractional digits');
});

test('survives amounts a double would round', () => {
	// 18 decimals: past what an IEEE double holds exactly, which is the reason these are strings.
	const raw = parseUnits('123456789.123456789123456789', 18);
	assert.equal(raw, '123456789123456789123456789');
	assert.equal(formatUnits(raw, 18), '123456789.123456789123456789');
});

test('formats raw units back, dropping trailing zeros', () => {
	assert.equal(formatUnits('1500000', 6), '1.5');
	assert.equal(formatUnits('1000000', 6), '1');
	assert.equal(formatUnits('1', 6), '0.000001');
	assert.equal(formatUnits('12', 0), '12');
});

test('round-trips', () => {
	for (const [human, dec] of [['1.5', 6], ['0.000001', 6], ['1000', 18], ['7', 0]] as const) {
		assert.equal(formatUnits(parseUnits(human, dec), dec), human);
	}
});
