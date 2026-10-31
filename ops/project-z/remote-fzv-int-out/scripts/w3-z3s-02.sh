#!/bin/bash
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export FINNOR_S3_PYTHON=/home/factory-user/repos/fzv-int-s3-python/bin/python
cd /home/factory-user/repos/fzv-w-z3 || exit 97
exec /home/factory-user/repos/fzv-int-out/native-run.sh w3-z3s-02 z0\,z3 finnor-os/scripts/project-z/native/z3-session.mjs --no-worker --z3-producer=/home/factory-user/repos/fzv-int-out/z3-assets-w3/cli.mjs
