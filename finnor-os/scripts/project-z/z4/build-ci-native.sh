#!/usr/bin/env bash
set -euo pipefail

evidence=${1:?absolute path for native build evidence is required}
[[ "$evidence" = /* && ! -e "$evidence" ]]
[[ "$(uname -s)" = Linux && "$(uname -m)" = x86_64 ]]

repository=$(git rev-parse --show-toplevel)
native_path=finnor-os/packages/epistemic-runtime/native/z4-execution-proof
scripts="$repository/finnor-os/scripts/project-z/z4"
destination="$repository/$native_path"
mkdir -m 0700 "$evidence"
build=$(mktemp -d "${RUNNER_TEMP:-/tmp}/finnor-z4-build.XXXXXXXX")
trap 'rm -rf -- "$build"' EXIT

# Keep dependency downloads and compiler output out of the API source context.
git -C "$repository" archive HEAD "$native_path" | tar -xf - -C "$build"
git -C "$repository" rev-parse HEAD 'HEAD^{tree}' > "$evidence/checkout.txt"
cp "$build/$native_path/build-identity.json" "$evidence/checkout-identity.json"
cmp "$evidence/checkout-identity.json" "$destination/build-identity.json"

python3 "$scripts/install-rust.py" --prefix "$build/rust" > "$evidence/rust-install.log" 2>&1
cp "$build/rust/receipt.json" "$evidence/rust-install.json"
python3 "$scripts/build-native.py" --native "$build/$native_path" \
  --rust-prefix "$build/rust/installed" --evidence "$evidence/locked-build"

# Rebuilt binary hashes are recorded independently from the historical hashes.
python3 - "$evidence" "$destination" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

evidence, destination = map(Path, sys.argv[1:])
checkout = json.loads((evidence / "checkout-identity.json").read_text())
installed = json.loads((evidence / "locked-build/identity.json").read_text())
for field in ("schema", "profile", "backend", "sourceFiles", "sourceDigest", "cargoLockSha256", "rustc", "target"):
    if checkout[field] != installed[field]:
        raise SystemExit(f"Z4 source or toolchain identity changed: {field}")
for source in installed["sourceFiles"]:
    path = destination / source["path"]
    if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != source["sha256"]:
        raise SystemExit(f"Z4 checkout source changed: {source['path']}")
PY

mkdir -m 0700 "$destination/bin"
install -m 0500 "$build/$native_path/bin/z4-proof" "$destination/bin/z4-proof"
install -m 0500 "$build/$native_path/bin/z4-field-falsifier" "$destination/bin/z4-field-falsifier"
install -m 0400 "$evidence/locked-build/identity.json" "$destination/build-identity.json"
