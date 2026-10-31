#!/bin/bash
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export FINNOR_S3_PYTHON=/home/factory-user/repos/fzv-int-s3-python/bin/python
cd /home/factory-user/repos/fzv-z2-pack-w2/install-03/pack || exit 97
exec /home/factory-user/repos/fzv-int-out/native-run-z2.sh w2-dev-04 /home/factory-user/repos/fzv-z2-pack-w2/install-03/pack /home/factory-user/repos/fzv-z2-pack-w2/install-03/install-report.json
