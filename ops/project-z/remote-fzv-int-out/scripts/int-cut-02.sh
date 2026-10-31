#!/bin/bash
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export FINNOR_S3_PYTHON=/home/factory-user/repos/fzv-int-s3-python/bin/python
cd /home/factory-user/repos/fzv-int-01 || exit 97
exec /bin/bash /home/factory-user/repos/fzv-int-out/scripts/int-cut.body.sh 02
