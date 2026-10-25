# Preserved install failure and toolchain correction

`reconstruction-01/product-install-01` failed at the actual root `npm ci`,
exit 1, after 847 SRI-verified tarballs were fetched. Its report, original
root log and private npm debug log remain. npm 11.19.1 reported missing
`@emnapi/core` and `@emnapi/runtime` peer records for a nested WASM runtime.
No application check, build or native owner qualification passed in that run.

The root `.npmrc` explicitly requires `legacy-peer-deps=false`. The existing
release failure history explains why bypassing normal peer resolution would
invalidate the locked graph. Do not use a peer-policy override or edit either
shared lockfile to hide this failure.

The source CI uses Node 22 (currently 22.22.3). The exact selected isolated
Node 22.23.4 tag's official `deps/npm/package.json` declares npm **10.9.9**:
`https://raw.githubusercontent.com/nodejs/node/v22.23.4/deps/npm/package.json`.
The prior engineering choice of npm 11.19.1 was not that bundled profile.
Correct the owned toolchain pin to exact npm 10.9.9, not an unpinned downgrade.
Public registry metadata declares tarball
`https://registry.npmjs.org/npm/-/npm-10.9.9.tgz`, SRI
`sha512-1g+6jLQvaIuB4zwvHL7yrXuXcWZwDsCtBX8bbWDqbvJSSr9nPiDDWTHNgwXR27iIcTTW7v3A57hDW9RYv2W4Yg==`.

Before replacing the owned npm prefix, require the exact prior terminal
receipt SHA, verify the installed Node hash, retain the prior prefix and
receipt, extract the new archive independently and observe both versions.
Do not call the new profile successful before an actual subsequent install.
Both lock hashes and the normal peer policy must remain unchanged. This
failure model precedes the replacement implementation, not the old product.
