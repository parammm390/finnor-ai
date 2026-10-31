#!/bin/bash
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export FINNOR_S3_PYTHON=/home/factory-user/repos/fzv-int-s3-python/bin/python
cd /home/factory-user/repos/fzv-z2-pack-w2/install-04/pack || exit 97
exec /home/factory-user/repos/fzv-int-out/native-run-z2.sh w2-native-01 /home/factory-user/repos/fzv-z2-pack-w2/install-04/pack /home/factory-user/repos/fzv-z2-pack-w2/install-04/install-report.json
