#!/bin/bash
# usage: wait-remote-exit.sh NAME [MAX_SECONDS]
# Blocks until /home/factory-user/repos/fzv-int-out/NAME.exit exists on the verify host, then prints exit code and log tail.
# Intended to be started with fireAndForget so its completion wakes the coordinator.
NAME=$1; MAX=${2:-14400}
F="-F /tmp/fzv-ssh-config"
OUT=/home/factory-user/repos/fzv-int-out
start=$(date +%s)
while true; do
  state=$(ssh $F -o ConnectTimeout=20 fzv "if [ -e $OUT/$NAME.exit ]; then echo FINISHED exit=\$(cat $OUT/$NAME.exit); elif [ -e $OUT/$NAME.log ]; then echo RUNNING; else echo WAITING; fi" 2>/dev/null | grep -v -E "Fetching computer info|Connecting to|Connected" | tail -1)
  case "$state" in
    FINISHED*) echo "$NAME $state"; ssh $F fzv "tail -n 12 $OUT/$NAME.log | cut -c1-600" 2>/dev/null | grep -v -E "Fetching computer info|Connecting to|Connected"; exit 0;;
  esac
  now=$(date +%s)
  if [ $((now - start)) -ge $MAX ]; then echo "$NAME TIMEOUT_WAITING last_state=$state"; exit 3; fi
  sleep 60
done
