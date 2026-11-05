#!/bin/sh
# Builds the core for the web – wasm32, through wasm-bindgen – into src/generated. Needs rustup with
# the wasm32-unknown-unknown target and wasm-bindgen-cli at the version bindings/wasm pins.
set -e

export PATH="$HOME/.cargo/bin:$PATH"
here=$(cd "$(dirname "$0")" && pwd)
cd "$here/../.."
cargo build -q -p shama-wasm --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir "$here/src/generated" target/wasm32-unknown-unknown/release/shama_wasm.wasm
echo "Web: $here/src/generated"
