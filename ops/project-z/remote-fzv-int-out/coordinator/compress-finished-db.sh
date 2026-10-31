#!/bin/bash
# usage: compress-finished-db.sh [--apply]
# Finds embedded-PostgreSQL data directories of finished native runs and (with --apply) replaces each by a .tar.gz beside it.
# A run is "finished" when no live process mentions its state directory and the directory is older than 15 minutes.
# Nothing else is touched; evidence logs stay as they are.
APPLY=$1
for w in /home/factory-user/repos/fzv-w-z0 /home/factory-user/repos/fzv-w-z1 /home/factory-user/repos/fzv-w-z2 /home/factory-user/repos/fzv-w-z3 /home/factory-user/repos/fzv-w-z4 /home/factory-user/repos/fzv-w-z5 /home/factory-user/repos/fzv-int-01; do
  for d in "$w"/.centropy-certification/*/; do
    d=${d%/}
    [ -d "$d/postgres" ] || continue
    if ps -eo args | grep -F -- "$d" | grep -v grep | grep -v compress-finished-db >/dev/null; then echo "LIVE   $d"; continue; fi
    if [ -n "$(find "$d" -maxdepth 1 -mmin -15 -print -quit)" ] || [ -n "$(find "$d/postgres" -maxdepth 1 -mmin -15 -print -quit)" ]; then echo "RECENT $d"; continue; fi
    sz=$(du -sm "$d/postgres" | cut -f1)
    if [ "$APPLY" = "--apply" ]; then
      if nice -n 19 taskset -c 2,3 tar -C "$d" -czf "$d/postgres.tar.gz.partial" postgres && mv "$d/postgres.tar.gz.partial" "$d/postgres.tar.gz" && tar -tzf "$d/postgres.tar.gz" >/dev/null; then
        rm -rf "$d/postgres"; echo "PACKED ${sz}MB -> $(du -sm "$d/postgres.tar.gz" | cut -f1)MB $d"
      else echo "FAILED $d"; rm -f "$d/postgres.tar.gz.partial"; fi
    else echo "WOULD  ${sz}MB $d"; fi
  done
done
df -h / | tail -1
