#!/bin/bash
# usage: compress-stale-coordinator.sh [--apply]
# Reclaims space in the superseded remote checkout /home/factory-user/repos/finnor-z-coordinator (no live process or script uses it).
#  1. check "home" directories larger than 50 MB are packed into <dir>/home.tar.gz (verified by tar -tzf and entry count) and then removed;
#  2. embedded-PostgreSQL data directories of its finished state directories are packed like compress-finished-db.sh does;
#  3. regenerable install/build output (node_modules, .next) is removed; lockfiles stay, so `npm ci` rebuilds it.
# Receipts, argv, logs and every other evidence file stay as they are. Dry run unless --apply.
APPLY=$1
R=/home/factory-user/repos/finnor-z-coordinator
CHECKS=$R/scope-z/orchestration/delivery-20261026/execution-recovery-25/remote/checks
AUDIT=/home/factory-user/repos/fzv-int-out/coordinator/audit
mkdir -p "$AUDIT"
LOG=$AUDIT/compress-stale-coordinator-$(date -u +%Y%m%dT%H%M%SZ).txt
exec > >(tee "$LOG") 2>&1
echo "# compress-stale-coordinator $(date -u +%FT%TZ) mode=${APPLY:-dry-run}"
if ps -eo args | grep -F -- "$R" | grep -v grep | grep -v compress-stale-coordinator >/dev/null; then echo "REFUSE: a live process mentions $R"; exit 2; fi
df -h / | tail -1

for h in "$CHECKS"/*/home; do
  [ -d "$h" ] || continue
  mb=$(du -sm "$h" | cut -f1)
  [ "$mb" -ge 50 ] || continue
  if [ "$APPLY" = "--apply" ]; then
    parent=$(dirname "$h")
    n=$(find "$h" | wc -l)
    if nice -n 19 tar -C "$parent" -czf "$parent/home.tar.gz.partial" home \
       && mv "$parent/home.tar.gz.partial" "$parent/home.tar.gz" \
       && [ "$(tar -tzf "$parent/home.tar.gz" | wc -l)" -eq "$n" ]; then
      rm -rf "$h"; echo "PACKED ${mb}MB -> $(du -sm "$parent/home.tar.gz" | cut -f1)MB $h ($n entries)"
    else echo "FAILED $h"; rm -f "$parent/home.tar.gz.partial"; fi
  else echo "WOULD pack ${mb}MB $h"; fi
done

for d in "$R"/.centropy-certification/*/; do
  d=${d%/}
  [ -d "$d/postgres" ] || continue
  mb=$(du -sm "$d/postgres" | cut -f1)
  if [ "$APPLY" = "--apply" ]; then
    if nice -n 19 tar -C "$d" -czf "$d/postgres.tar.gz.partial" postgres && mv "$d/postgres.tar.gz.partial" "$d/postgres.tar.gz" && tar -tzf "$d/postgres.tar.gz" >/dev/null; then
      rm -rf "$d/postgres"; echo "PACKED ${mb}MB -> $(du -sm "$d/postgres.tar.gz" | cut -f1)MB $d/postgres"
    else echo "FAILED $d"; rm -f "$d/postgres.tar.gz.partial"; fi
  else echo "WOULD pack ${mb}MB $d/postgres"; fi
done

for g in "$R/node_modules" "$R/finnor-os/node_modules" "$R/.next"; do
  [ -d "$g" ] || continue
  mb=$(du -sm "$g" | cut -f1)
  if [ "$APPLY" = "--apply" ]; then rm -rf "$g" && echo "REMOVED regenerable ${mb}MB $g"; else echo "WOULD remove regenerable ${mb}MB $g"; fi
done
for g in "$R"/finnor-os/apps/*/.next; do
  [ -d "$g" ] || continue
  mb=$(du -sm "$g" | cut -f1)
  if [ "$APPLY" = "--apply" ]; then rm -rf "$g" && echo "REMOVED regenerable ${mb}MB $g"; else echo "WOULD remove regenerable ${mb}MB $g"; fi
done
df -h / | tail -1
