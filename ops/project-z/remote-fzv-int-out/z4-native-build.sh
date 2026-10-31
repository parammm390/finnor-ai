#!/bin/bash
set -u
RR=/home/factory-user/repos/fzv-int-01
PREFIX=/home/factory-user/repos/finnor-z-toolchains/rust-1.92.0-int01
EV=/home/factory-user/repos/fzv-int-out/z4-native-build-01
cd $RR/finnor-os/scripts/project-z/z4 || exit 97
if [ ! -d "$PREFIX/installed" ]; then
  rm -rf "$PREFIX"
  python3 install-rust.py --prefix "$PREFIX" || exit 11
fi
rm -rf "$EV"
nice -n 10 python3 build-native.py --native $RR/finnor-os/packages/epistemic-runtime/native/z4-execution-proof --rust-prefix "$PREFIX/installed" --evidence "$EV"
