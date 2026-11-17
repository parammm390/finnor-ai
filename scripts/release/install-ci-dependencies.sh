#!/usr/bin/env bash
set -euo pipefail

# The root app and finnor-os have separate lockfiles and install directories.
npm ci --no-audit --no-fund &
root_install=$!
npm ci --prefix finnor-os --no-audit --no-fund &
backend_install=$!
trap 'kill "$root_install" "$backend_install" 2>/dev/null || true; exit 1' INT TERM

failed=0
if ! wait "$root_install"; then
  echo "Root dependency installation failed" >&2
  failed=1
fi
if ! wait "$backend_install"; then
  echo "Backend dependency installation failed" >&2
  failed=1
fi
exit "$failed"
