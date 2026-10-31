#!/bin/bash
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export FINNOR_S3_PYTHON=/home/factory-user/repos/fzv-int-s3-python/bin/python
cd /home/factory-user/repos/fzv-w-z3/finnor-os || exit 97
exec /home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin/node --max-old-space-size=6144 /home/factory-user/repos/fzv-w-z3/finnor-os/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
