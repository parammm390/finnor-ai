#!/bin/bash
set -e
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export FINNOR_S3_PYTHON=/home/factory-user/repos/fzv-int-s3-python/bin/python
W=/home/factory-user/repos/fzv-w-z2
P=/home/factory-user/repos/fzv-z2-pack-w2
cd $W
COMMIT=$(git rev-parse HEAD)
echo "commit=$COMMIT"
/usr/bin/python3 -I -B $W/finnor-os/scripts/project-z/z2/prepare-replay.py --repo $W --git-commit $COMMIT --external-root $P --output $P/recon-03
exec /usr/bin/python3 -I -B $W/finnor-os/scripts/project-z/z2/install-owner.py --repo $P --external-root $P --source-tree $P/recon-03/tree --evidence-dir $P/install-03 --node $P/toolchain/bin/node --temporary-cache-parent /dev/shm --node-version-pin 22.23.4 --node-headers-seed /home/factory-user/.cache/node-gyp --public-env NEXT_PUBLIC_SUPABASE_URL=https://127.0.0.1:54443 --public-env NEXT_PUBLIC_SUPABASE_ANON_KEY=z2-installed-anon-placeholder-not-validated
