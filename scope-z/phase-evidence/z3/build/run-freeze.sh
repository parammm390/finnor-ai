set -eu
cd /home/factory-user/repos/finnor-z3
OUT=scope-z/phase-evidence/z3/native-freeze-v2.sha256
{
echo "# schema: finnor.z3.native-freeze.v1"
echo "# generatedAt: $(date -u +%FT%TZ)"
echo "# branch: $(git symbolic-ref --short HEAD)"
echo "# baseCommit: 9f3edfd3b4c6758832c53139da0773218062191e"
echo "# headCommit: $(git rev-parse HEAD)"
echo "# headTree: $(git rev-parse HEAD^{tree})"
echo "# scopeRoots: finnor-os/packages/epistemic-runtime/src/project-z/z3-viability finnor-os/packages/private-equity/src/project-z/z3-viability finnor-os/scripts/project-z/z3 scripts/project-z/z3 scope-z/phase-evidence/z3"
echo "# exclusions: __pycache__, build/patch-check (generator full-tree scratch), build/pg-libs (environment symlinks), this manifest"
echo "# verify: tail -n +11 $OUT | sha256sum -c -"
find finnor-os/packages/epistemic-runtime/src/project-z/z3-viability \
     finnor-os/packages/private-equity/src/project-z/z3-viability \
     finnor-os/scripts/project-z/z3 \
     scripts/project-z/z3 \
     scope-z/phase-evidence/z3 \
     -type f \
     ! -path '*__pycache__*' \
     ! -path '*/build/patch-check/*' \
     ! -path '*/build/pg-libs/*' \
     ! -name 'native-freeze-v2.sha256' \
  | LC_ALL=C sort | xargs sha256sum
} > "$OUT"
wc -l "$OUT"
