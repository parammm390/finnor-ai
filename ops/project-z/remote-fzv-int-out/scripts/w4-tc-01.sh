#!/bin/bash
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export FINNOR_S3_PYTHON=/home/factory-user/repos/fzv-int-s3-python/bin/python
cd /home/factory-user/repos/fzv-w-z4 || exit 97
exec /usr/bin/env bash -c export\ PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:\$PATH\;\ npm\ --prefix\ finnor-os\ run\ typecheck
