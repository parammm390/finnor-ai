# Combined build 01: successful processes, rejected immutable-source receipt

Frontend and API builds each exited 0. All four source-stamp writes/checks,
Z0 JavaScript syntax and Z0 tooling types exited 0. Both actual BUILD_ID files
contain `z-combined-066ac61f896afaa3086a`, exactly the requested identity.

The enclosing run correctly exited 1 with SOURCE_CHANGED_DURING_BUILD.
Its only changed inventory member is root next-env.d.ts:
- before: 1862ac4bbbc5192d4bf562161df66ea547ed3e67173100656ab606ae9797db2b
- after: f39b312cebdf194b5a9d5f6d7e739ada61def0b38980c0e73ed326da5769048d

The two generated imports now point to .next-z1-install/types rather than
.next/types, matching the explicitly selected standalone distDir. Installed
Next documentation states that build/typegen regenerate this managed file.
This is not evidence of a product-code edit during compilation. It still
invalidates the strict pre-build population identity, and the failed report
must not be changed to PASSED.

For the next justified combined build, first run the same explicit profile's
Next typegen, then inventory its actual bytes before building. Retain the
generated member and reject any later drift. Do not omit all generated types
or hand-edit next-env.d.ts to make the check pass. Defer that rebuild until
pending corrective product changes are settled.

No database, Auth, native owner, installed reconstruction or qualification
result follows from this ordinary in-place compilation.
