#!/bin/bash
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export FINNOR_S3_PYTHON=/home/factory-user/repos/fzv-int-s3-python/bin/python
cd /home/factory-user/repos/fzv-w-z3/finnor-os || exit 97
exec /home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin/node --import /home/factory-user/repos/fzv-w-z3/finnor-os/node_modules/tsx/dist/loader.mjs /home/factory-user/repos/fzv-int-out/forensic-submit.mts w3-z3s-02
