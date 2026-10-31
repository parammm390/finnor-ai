#!/bin/bash
# The Z1 session itself refuses inside the last 100 minutes of the UTC day, but only after the isolated stack has been
# brought up. Decide before holding the stack so a late start is a recorded deferral, not a wasted bring-up.
remaining=$(( 86400 - $(date -u +%s) % 86400 ))
if [ "$remaining" -lt 6900 ]; then
  echo "DEFERRED_UTC_MIDNIGHT_GUARD remaining_seconds=$remaining; nothing was started, no evidence directory was created"
  exit 75
fi
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export FINNOR_S3_PYTHON=/home/factory-user/repos/fzv-int-s3-python/bin/python
cd /home/factory-user/repos/fzv-w-z1 || exit 97
exec /usr/bin/env PLAYWRIGHT_BROWSERS_PATH=/home/factory-user/repos/fzv-browsers /home/factory-user/repos/fzv-int-out/native-run.sh w1-native-10 z1 finnor-os/scripts/project-z/native/z1-session.mjs --no-worker --budget-ms=7200000 --forward-env=PLAYWRIGHT_BROWSERS_PATH
