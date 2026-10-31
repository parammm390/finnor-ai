#!/bin/bash
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export FINNOR_S3_PYTHON=/home/factory-user/repos/fzv-int-s3-python/bin/python
cd /home/factory-user/repos/fzv-w-z3 || exit 97
exec /home/factory-user/repos/fzv-int-out/native-run.sh w3-gov-02 z0 finnor-os/scripts/project-z/z3/s4-governed-child-session.mjs --no-worker
