set -u
cd /home/factory-user/repos/finnor-z3
D=scope-z/phase-evidence/z3
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/.bin:$PATH
NATIVELIB=/home/factory-user/repos/finnor-z3/finnor-os/node_modules/@embedded-postgres/linux-x64/native/lib
export LD_LIBRARY_PATH="$PWD/$D/build/pg-libs:$NATIVELIB${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
{
echo "== node $(node --version) =="
echo "== migration payload validation (seed-split fix, pinned toolchain) $(date -u +%FT%TZ)"
node "$D/build/validate-migration-0199.mjs"; echo "migration-exit=$?"
} > "$D/independent-verify-migration-2.log" 2>&1
{
echo "== node $(node --version); independence probe under pinned toolchain $(date -u +%FT%TZ)"
python3 finnor-os/scripts/project-z/z3/probe-independence.py \
  --cli "$D/build/cli.mjs" \
  --output "$D/runs/03c-independence-pinned-toolchain"; echo "probe-exit=$?"
} > "$D/independent-verify-probe-2.log" 2>&1
