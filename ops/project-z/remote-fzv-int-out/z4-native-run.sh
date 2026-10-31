#!/bin/bash
# usage: z4-native-run.sh NAME PROFILES SCENARIO_REL [--session-stage=seed|full] [extra runner args...]   (cwd = remote worktree)
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export FINNOR_S3_PYTHON=/home/factory-user/repos/fzv-int-s3-python/bin/python
export FINNOR_Z4_CHROMIUM=/home/factory-user/repos/fzv-browsers/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell
NAME=$1; PROFILES=$2; SCEN=$3; shift 3
ARGS=()
for a in "$@"; do
  case "$a" in
    --session-stage=*) export FINNOR_Z4_SESSION_STAGE=${a#--session-stage=};;
    *) ARGS+=("$a");;
  esac
done
R=$(pwd)
OUT=/home/factory-user/repos/fzv-int-out/native
cd $R
git checkout -- next-env.d.ts finnor-os/apps/api/next-env.d.ts 2>/dev/null
for p in 3001 3101 55441 54321 54322 54443; do if ss -ltn | grep -q ":$p "; then echo "PORT_BUSY $p"; exit 75; fi; done
FWD=(--forward-env=FINNOR_S3_PYTHON --forward-env=FINNOR_Z4_CHROMIUM)
[ -n "$FINNOR_Z4_SESSION_STAGE" ] && FWD+=(--forward-env=FINNOR_Z4_SESSION_STAGE)
exec taskset -c 0,1,2 node scripts/project-z/run-native-scenario.mjs --name=$NAME --evidence=$OUT/$NAME --archive=/tmp/fzv-native-02/auth-toolchain/auth.tar.xz --profiles=$PROFILES --scenario=$R/$SCEN "${FWD[@]}" "${ARGS[@]}"
