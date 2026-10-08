# Isolated runtime closure, historical probe and continuation

The original setup below did not change economic code, owner deadlines,
migrations, package locks, or the first native implementation/evidence. The
later additive M3 continuation does change production code, candidate 0158 and
the backend lockfile. Its exact identities and validation are separate in
`evidence-index.json`. Neither establishes GateM3, a final M1 join, scientific
admission, or a browser/UI pass.

## Probe acceptance and failure modes

Registered before adding the reusable runtime probe: exercise a real native
`fs-ext` exclusive-lock contention; initialize, start, query and stop a fresh
embedded PostgreSQL on a dynamic loopback port other than 5432; verify installed
S3 scientific pins under checkout-local Python 3.11 and S5 pins/HiGHS under
checkout-local Python 3.12; execute the locally built Apple Vision binary on
generated PNG bytes. Record source, runtime and lockfile SHA-256 identities,
actual observations, cleanup and an immutable new receipt.

Failures include missing/wrong native ABI or platform binary, an ineffective
lock, forbidden/shared port, failed init/start/query/stop, surviving listener,
missing/wrong Python or scientific/HiGHS pins, missing or failing OCR executable,
changed lockfiles, and overwritten evidence. No dependency or owner predicate
may be replaced by a peer runtime. A successful probe establishes runtime
availability only, not full owner correctness or physical aggregate isolation.

## Reproduction

From this checkout, use the manifest `install`, `typecheck`, `test` and
`m3_runtime_check` commands. Python environments were installed with `uv` using
existing trusted CPython 3.11.15 and 3.12.13 interpreters, not a peer environment:

```sh
uv venv --python /Users/paramdave/.local/share/uv/python/cpython-3.11-macos-aarch64-none/bin/python3.11 .m1-python
uv pip install --python .m1-python/bin/python -r finnor-os/packages/epistemic-runtime/src/intervention-requirements.txt
uv venv --python /Users/paramdave/.local/share/uv/python/cpython-3.12-macos-aarch64-none/bin/python3.12 .m1-s5-python
uv pip install --python .m1-s5-python/bin/python -r finnor-os/packages/epistemic-runtime/src/requirements-s5.txt
mkdir -p .p4-runtime
clang -fobjc-arc -O2 -framework Foundation -framework Vision -framework ImageIO -framework CoreGraphics finnor-os/packages/private-equity/src/evidence-execution/vision-ocr.m -o .p4-runtime/vision-ocr
```

The first OCR link failed because CoreGraphics was omitted. This failure is
retained in the setup receipt, not converted into a successful first attempt.
Cold scientific imports exceeded the existing 20-second S3 backend deadline in
the first M1 selected run; warming installed imports and rerunning unchanged
owner code passed the four matching cases. The requested
`actual-s6-unknown-effect-liability` selector matched no case in this committed
runner. An exit code of zero is not a five-case pass.

Historical registration recovery is byte-for-byte against the immutable Git
blob IDs in the frozen control index, never from a live primary/peer. Its
separate provenance receipt records capture/index hashes and missing sources.
Recovery now does not retroactively preregister any test.

## Observed scope and exclusions

At the historical runtime-probe cut, the two lockfiles retained these SHA-256 hashes:
`6a294c8ad8e54a88ae07d63f8ec193739f860a2696aef030abdc84268b311521`
(root) and
`54d1f69642fa11a06ee9501ce31646d3c12173efea199154ee77860739653b68`
(backend). The scoped native runner passed 9 cases, underwriting passed 46 tests,
and root/backend typecheck passed. The recovered S5 runner passed its selected
`coupled-choice-original-covenant-and-bound` case with 154 disposable migrations.

The first runtime probe retained a failure from Vision refusing a 1×1 input.
Its receipt said FAIL although the embedded package's exit hook returned zero.
The probe now uses a 64×64 generated PNG and explicitly exits after cleanup.
Its successful receipt includes actual lock contention, scientific pins,
HiGHS 1.8.0, Vision output, PostgreSQL query/version and connection refusal after
stopping the owned listener.

At that probe cut, S3's failure model and S4's failure model/additional/final
challenge registration were unavailable from verified captured blobs. That
observation is historical, not the current source-closure state.
`scope-evidence/runtime-registration-recovery-completion.json` subsequently
records byte-identical recovery of those exact immutable Git objects.
`scope-evidence/final-s2-registration-recovery.json` records the later exclusive
S2 plan/failure-model recovery against the frozen control blob IDs. No live peer
working files were imported, and recovery is not retroactive preregistration.

The unchanged original S1/S2/S3/S4/S5 runners then passed 28/19/16/38/14 cases.
The explicit original M1 non-browser selection passed 18 cases. The M3-owned
native provider passed 54 unchanged queue/underwriting/IC integration tests.
Each receipt has its own source cut and limitations; none requalifies every
later source version. `evidence-index.json` identifies the exact receipts.
The manifest's old `p4_full` and `owner_regressions` commands referred to absent
M1 scripts and were not substituted or reported run.
P4 document-fixture Python dependencies (openpyxl, Pillow and reportlab) have no
checkout pin file and were not installed speculatively. No full P4, hosted auth,
UI, final M1 or S8 result is claimed.

Npm reported existing locked advisories (root: 11, including 1 critical;
backend: 7). No audit fix or lockfile upgrade was authorized or attempted.
Original setup raw owner directories stay local and ignored. The continuation
handoff retains new run bytes in verified, lossless evidence archives, including
failed runs, with original paths and hashes. It does not delete or rewrite the
raw directories. The preexisting untracked `base-receipt.json` remains untouched.
