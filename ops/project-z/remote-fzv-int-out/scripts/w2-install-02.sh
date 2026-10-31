#!/bin/bash
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export FINNOR_S3_PYTHON=/home/factory-user/repos/fzv-int-s3-python/bin/python
cd /home/factory-user/repos/fzv-w-z2 || exit 97
exec /usr/bin/python3 -I -B /home/factory-user/repos/fzv-w-z2/finnor-os/scripts/project-z/z2/install-owner.py --repo /home/factory-user/repos/fzv-z2-pack-w2 --external-root /home/factory-user/repos/fzv-z2-pack-w2 --source-tree /home/factory-user/repos/fzv-z2-pack-w2/recon-02/tree --evidence-dir /home/factory-user/repos/fzv-z2-pack-w2/install-02 --node /home/factory-user/repos/fzv-z2-pack-w2/toolchain/bin/node --temporary-cache-parent /dev/shm --node-version-pin 22.23.4 --node-headers-seed /home/factory-user/.cache/node-gyp --public-env NEXT_PUBLIC_SUPABASE_URL=https://127.0.0.1:54443 --public-env NEXT_PUBLIC_SUPABASE_ANON_KEY=z2-installed-anon-placeholder-not-validated
