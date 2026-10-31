#!/bin/bash
# usage: queue-run.sh NAME MODE CWD  (runs fzv-int-out/scripts/NAME.sh through run.sh, holding the requested locks)
NAME=$1; MODE=$2; CWD=$3
OUT=/home/factory-user/repos/fzv-int-out
HEAVY=/home/factory-user/repos/finnor-z-shared-heavy.lock
STACK=/home/factory-user/repos/finnor-z-stack.lock
date -u +%FT%TZ > $OUT/$NAME.queued
case "$MODE" in
  heavy) flock -x $HEAVY $OUT/run.sh $NAME $CWD -- $OUT/scripts/$NAME.sh ;;
  stack) flock -x $STACK flock -s $HEAVY $OUT/run.sh $NAME $CWD -- $OUT/scripts/$NAME.sh ;;
  *) $OUT/run.sh $NAME $CWD -- $OUT/scripts/$NAME.sh ;;
esac
rm -f $OUT/$NAME.queued
