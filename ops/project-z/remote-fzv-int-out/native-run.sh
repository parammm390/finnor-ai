#!/bin/bash
# usage: native-run.sh NAME PROFILES SCENARIO_REL [extra runner args...]
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export FINNOR_S3_PYTHON=/home/factory-user/repos/fzv-int-s3-python/bin/python
NAME=$1; PROFILES=$2; SCEN=$3; shift 3
R=$(pwd)
OUT=/home/factory-user/repos/fzv-int-out/native
cd $R
git checkout -- next-env.d.ts 2>/dev/null
for p in 3001 3101 55441 54321 54322; do if ss -ltn | grep -q ":$p "; then echo "PORT_BUSY $p"; exit 75; fi; done
exec taskset -c 0,1 node scripts/project-z/run-native-scenario.mjs --name=$NAME --evidence=$OUT/$NAME --archive=/tmp/fzv-native-02/auth-toolchain/auth.tar.xz --profiles=$PROFILES --scenario=$R/$SCEN --forward-env=FINNOR_S3_PYTHON "$@"
