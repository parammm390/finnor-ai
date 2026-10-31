#!/bin/bash
# usage: run.sh NAME CWD -- argv...   (records start/end, exit code, head)
NAME="$1"; CWD="$2"; shift 3
OUT=/home/factory-user/repos/fzv-int-out
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
cd "$CWD" || exit 97
rm -f "$OUT/$NAME.exit"
{ echo "# name=$NAME cwd=$CWD head=$(git rev-parse HEAD 2>/dev/null) start=$(date -u +%FT%TZ)"; echo "# argv: $*"; } > "$OUT/$NAME.log"
# A job that holds the stack lock must start from a quiet host: a worker left behind by an earlier run reconnects to this
# run's database (fixed port) and claims its jobs. Refuse before anything starts; nothing is signalled here.
holds_stack_lock() {
  local p=$PPID i=0
  while [ "$p" -gt 1 ] && [ "$i" -lt 4 ]; do
    case "$(ps -o args= -p "$p" 2>/dev/null)" in *finnor-z-stack.lock*) return 0;; esac
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' '); [ -n "$p" ] || break; i=$((i+1))
  done
  return 1
}
if holds_stack_lock; then
  python3 "$OUT/quiescence-check.py" --reap > "$OUT/$NAME.quiescence.json" 2>&1; Q=$?
  if [ "$Q" -eq 76 ]; then
    { echo "# STACK_NOT_QUIESCENT: another process of this user holds a stack port, a connection to the shared database, or is a stock worker. Nothing was started."; cat "$OUT/$NAME.quiescence.json"; echo "# end=$(date -u +%FT%TZ) exit=76"; } >> "$OUT/$NAME.log"
    echo 76 > "$OUT/$NAME.exit"; exit 76
  elif [ "$Q" -ne 0 ]; then
    echo "# QUIESCENCE_CHECK_ERROR rc=$Q (check could not run; job continues unguarded)" >> "$OUT/$NAME.log"
  fi
fi
"$@" >> "$OUT/$NAME.log" 2>&1
RC=$?
echo "# end=$(date -u +%FT%TZ) exit=$RC" >> "$OUT/$NAME.log"
echo $RC > "$OUT/$NAME.exit"
exit $RC
