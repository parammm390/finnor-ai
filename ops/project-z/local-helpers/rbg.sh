#!/bin/bash
# usage: rbg.sh NAME REMOTE_CWD MODE -- ABSOLUTE_ARGV...
#   NAME  : unique immutable run name (never reuse one: pick a new name for every rerun, keep failed runs)
#   MODE  : none | heavy | stack
#             heavy = exclusive lock for typecheck/build/embedded-PG test/regression jobs (anything over ~1.5 GB RAM)
#             stack = exclusive stack lock AND the heavy lock held shared, for anything that binds ports 3001/3101/55441/54321/54443
#   ARGV  : absolute paths only (the job starts with cwd = REMOTE_CWD, Node 22 on PATH)
# The job runs in the background on the verify host. Results: /home/factory-user/repos/fzv-int-out/NAME.log and NAME.exit
# Check with: rstatus.sh NAME
set -e
NAME=$1; CWD=$2; MODE=$3; shift 3
[ "$1" = "--" ] && shift
[ -n "$NAME" ] && [ -n "$CWD" ] && [ -n "$MODE" ] && [ $# -gt 0 ] || { echo "usage: rbg.sh NAME REMOTE_CWD MODE -- ABSOLUTE_ARGV..."; exit 2; }
F="-F /tmp/fzv-ssh-config"
OUT=/home/factory-user/repos/fzv-int-out
tmp=$(mktemp)
{
  echo '#!/bin/bash'
  echo 'export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH'
  echo 'export FINNOR_S3_PYTHON=/home/factory-user/repos/fzv-int-s3-python/bin/python'
  printf 'cd %q || exit 97\nexec' "$CWD"
  printf ' %q' "$@"
  echo
} > "$tmp"
scp $F -q "$tmp" fzv:$OUT/scripts/$NAME.sh 2>/dev/null || { ssh $F fzv "mkdir -p $OUT/scripts" 2>/dev/null; scp $F -q "$tmp" fzv:$OUT/scripts/$NAME.sh 2>/dev/null; }
rm -f "$tmp"
ssh $F fzv "chmod +x $OUT/scripts/$NAME.sh; test ! -e $OUT/$NAME.exit && test ! -e $OUT/$NAME.log && (nohup $OUT/queue-run.sh $NAME $MODE $CWD > /dev/null 2>&1 &) && echo started $NAME || echo NAME_ALREADY_USED_PICK_A_NEW_NAME" 2>/dev/null | grep -v -E "Fetching computer info|Connecting to|Connected"
