set -u
cd /home/factory-user/repos/finnor-z3
D=scope-z/phase-evidence/z3
{
echo "== migration payload validation (postz rename, independent re-run) $(date -u +%FT%TZ)"
node "$D/build/validate-migration-0199.mjs"; echo "migration-exit=$?"
} > "$D/independent-verify-migration-2.log" 2>&1
{
echo "== independence/digest probe re-run $(date -u +%FT%TZ)"
python3 finnor-os/scripts/project-z/z3/probe-independence.py \
  --cli "$D/build/cli.mjs" \
  --output "$D/runs/03b-independence-digest-reverification"; echo "probe-exit=$?"
} > "$D/independent-verify-probe.log" 2>&1
