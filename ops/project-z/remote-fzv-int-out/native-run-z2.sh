#!/bin/bash
# usage: native-run-z2.sh NAME PACK_DIR INSTALL_REPORT — installed-pack Z2 native stack + replay session
set -e
NAME=$1; PACK=$2; REPORT=$3
export PATH=/home/factory-user/repos/fzv-z2-pack-w2/toolchain/bin:/usr/bin:/bin
export FINNOR_Z2_PACK_ROOT=$PACK
export FINNOR_S3_PYTHON=/home/factory-user/repos/fzv-int-s3-python/bin/python
OUT=/home/factory-user/repos/fzv-int-out/native
for p in 3001 3101 55441 54321 54322 54443; do if ss -ltn | grep -q ":$p "; then echo "PORT_BUSY $p"; exit 75; fi; done
cd $PACK
exec taskset -c 0,1 node $PACK/finnor-os/scripts/project-z/native/z2-stack.mjs --name=$NAME --evidence=$OUT/$NAME --archive=/tmp/fzv-native-02/auth-toolchain/auth.tar.xz --install-report=$REPORT --scenario=$PACK/finnor-os/scripts/project-z/native/z2-session.mjs --forward-env=FINNOR_S3_PYTHON
