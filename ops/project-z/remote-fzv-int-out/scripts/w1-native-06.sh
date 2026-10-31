#!/bin/bash
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export FINNOR_S3_PYTHON=/home/factory-user/repos/fzv-int-s3-python/bin/python
cd /home/factory-user/repos/fzv-w-z1 || exit 97
exec /usr/bin/env PLAYWRIGHT_BROWSERS_PATH=/home/factory-user/repos/fzv-browsers /home/factory-user/repos/fzv-int-out/native-run.sh w1-native-06 z1 finnor-os/scripts/project-z/native/z1-session.mjs --no-worker --budget-ms=7200000 --forward-env=PLAYWRIGHT_BROWSERS_PATH
