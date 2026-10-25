# Retained normalization failure, not a product failure

The first evidence adapter exited 1 before writing any normalized outputs.
`normalization-emit.log` retains the original `Z3_MODE_CHANGED` error.
Its schema mistake was parsing the Z3 shared request's `mode` as octal.
For shared requests this field means `EXACT_PREIMAGE` or
`COMPOSED_ONTO_Z1_SHARED_WORK_PREIMAGE`, not a file permission.

The correction applies octal parsing only to the 22 owned Git modes.
All 170 POSIX modes, including the four shared files, still require exact
equality between the reviewed preflight row and the live regular file.
All four shared postimages use `actualPostimageSha256`, including the
composed allocation-store postimage. No expected product value changed.

The next emission uses a different log. The failed log is not overwritten.
