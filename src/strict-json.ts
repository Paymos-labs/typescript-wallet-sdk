/**
 * JSON for the blind-sign guard, read the way the on-chain verifier reads it.
 *
 * `JSON.parse` keeps the LAST of a repeated object key. The guard approves a message whose exact
 * bytes the verifier parses again, with a reader that rejects a repeated field — so a message that
 * names one key twice says two different things, and whichever one this side read, the other is a
 * reading somebody else may act on. No message the server builds repeats a key; one that does is
 * refused here rather than read one way.
 *
 * `JSON.parse` also accepts any depth, where the verifier's reader stops (serde_json, at 128). A
 * message nested past {@link MAX_DEPTH} is refused too, as every other SDK's guard refuses it — a
 * transfer message is four levels deep.
 *
 * (Key case is not the issue in this language: `JSON.parse` keeps `"intents"` and `"Intents"` as
 * two keys and the guard reads the exact one, as the verifier does. A `"__proto__"` key becomes an
 * ordinary own property under `JSON.parse`, never the prototype.)
 */
import { PaymosError } from './errors.js';

/** Nesting deeper than this is refused. */
export const MAX_DEPTH = 64;

/** `JSON.parse`, refusing any object — at any depth — that repeats a key, and any depth past MAX_DEPTH. */
export function parseStrict(text: string): unknown {
	const value: unknown = JSON.parse(text); // syntax first: the scan below relies on valid JSON
	scanKeysAndDepth(text);
	return value;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;

const isJsonSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/**
 * Walks text `JSON.parse` has already accepted — iteratively, so the input chooses no recursion
 * depth — tracking the keys of every open object. A string followed by `:` is a key (in valid JSON
 * no value string is), compared after its escapes are resolved, so `"intents"` is `"intents"`.
 */
function scanKeysAndDepth(text: string): void {
	const open: Array<Set<string> | null> = []; // one per open container: an object's keys, or null for an array
	let i = 0;
	while (i < text.length) {
		const c = text.charCodeAt(i);
		if (c === QUOTE) {
			let end = i + 1;
			while (text.charCodeAt(end) !== QUOTE) end += text.charCodeAt(end) === BACKSLASH ? 2 : 1;
			const literal = text.slice(i, end + 1);
			i = end + 1;
			let next = i;
			while (next < text.length && isJsonSpace(text.charCodeAt(next))) next++;
			if (text.charCodeAt(next) === COLON) {
				const keys = open[open.length - 1];
				const key = JSON.parse(literal) as string;
				if (!keys || keys.has(key)) throw new PaymosError(`duplicate key ${JSON.stringify(key)}`);
				keys.add(key);
			}
			continue;
		}
		if (c === 0x7b /* { */ || c === 0x5b /* [ */) {
			if (open.length >= MAX_DEPTH) throw new PaymosError(`nested deeper than ${MAX_DEPTH} levels`);
			open.push(c === 0x7b ? new Set() : null);
		} else if (c === 0x7d /* } */ || c === 0x5d /* ] */) {
			open.pop();
		}
		i++;
	}
}
