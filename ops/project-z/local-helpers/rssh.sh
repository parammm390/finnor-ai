#!/bin/bash
# usage: rssh.sh 'remote shell command'   (runs on the verify host, filters connection chatter, keeps the exit code)
# Short commands only (reads, git, ls, tail). Long work goes through rbg.sh.
out=$(mktemp)
ssh -F /tmp/fzv-ssh-config fzv "$@" >"$out" 2>&1
rc=$?
grep -v -E "Fetching computer info|Connecting to|Connected" "$out"
rm -f "$out"
exit $rc
