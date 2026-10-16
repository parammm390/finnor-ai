# Retained attempt accounting

The authenticated R1 reader projects measurements from existing immutable attempt receipts. It validates each body digest and excludes raw bodies from public attempt metadata. No ledger, table, grant, authority or pricebook was added.

The failure model and eight isolated cases preceded implementation. The existing owner E2E now checks measurements against actual durable attempts, verifies body omission, and checks the mounted projection's reader contract. It does not claim browser acceptance from that projection.

New ordinary evidence:

- Eight specified isolated accounting cases: PASS.
- Helper and focused API/shared-type strict checks: PASS.
- Full unchanged strict backend graph: PASS, 4 GiB heap, 50.953 seconds, original 600-second static ceiling.
- Authenticated source-route HTTP → ordinary-role SQL → queue → physical worker/checker → real S4/S5: PASS. All three child receipts match the reader. Both unselected owner cases remain NOT RUN.
- The first owner attempt failed before startup because dependency links selected the older R2 workspace. Corrected task-owned links select local workspaces; third-party targets were not modified.
- Disposable database teardown: PASS; no owned postmaster remained.

Original 1 GiB heap failure and 2 GiB/150-second timeout remain retained. No product response deadline or accepted episode grant was enlarged.

This evidence is ordinary macOS development acceptance. The earlier Linux image belongs to its original source cut, not this changed reader. Final Linux/mounted/cumulative acceptance remains open.

CPU is a subtotal of distinct observed children, not complete-episode cost. Separate process high-water marks are not aggregate simultaneous peak memory. Dollar, human, build/cache/storage and complete-episode gaps remain explicit.

`retained-accounting-verification.json` binds source and retained evidence hashes. Raw evidence stays in the task-owned handoff; it is not copied into this PR.
