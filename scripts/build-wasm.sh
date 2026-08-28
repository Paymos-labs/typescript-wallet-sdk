#!/usr/bin/env bash
# Builds the co-signing core to WebAssembly.
#
# One artefact serves every platform this package runs on, which is the reason TypeScript was the
# second language rather than the fifth: the Python SDK needs a compiled extension per OS and
# architecture, and this needs a file.
#
# The crate is the SAME one the Python SDK and the .NET server call. Nobody reimplements FROST.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crate="$here/../rust/wallet-mpc"
out="$here/../wasm"

command -v wasm-pack >/dev/null 2>&1 || {
  echo "wasm-pack is required: cargo install wasm-pack" >&2
  exit 1
}

rm -rf "$out"
wasm-pack build "$crate" --release --target nodejs --out-dir "$out" --out-name wallet_mpc
# wasm-pack writes a manifest for publishing the wasm as its own package; this package ships it as
# an asset instead. It cannot simply be deleted: the SDK is "type": "module", and without a marker
# Node reads wasm-pack's CommonJS output as ESM and dies on `exports is not defined`. Replace it
# with the one field that matters.
printf '{\n  "type": "commonjs"\n}\n' > "$out/package.json"
rm -f "$out/.gitignore"
echo "wasm built → $out"
