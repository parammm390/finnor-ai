# Preregistered integrated-source repair contracts

These checks concern build/provenance integration. They do not change the
frozen X3 business oracle, any original campaign threshold or the full PRD.
Register this document and `api-additions.json` before implementation.

## Failure model and observable contracts

1. **Stale X3 check silently repairs the evidence.** The original X3 stamp
   ignores `--check` and writes its manifest. After a legitimate pinned-source
   repair, check mode must exit nonzero with `X3_SOURCE_STAMP_STALE`, and the
   manifest hash before/after must be identical. Ordinary generation remains
   deterministic and check mode passes without writes once current.
2. **Ordinary build emits an out-of-date X4 cut.** Original API build seals
   X3/X5 but not X4. After the legitimate X3 source change, run that original
   ordinary build and preserve its receipt; the subsequent read-only X4 stamp
   check must reject the stale scientific cut. Repair only the normal build
   sequence to X3 -> X5 -> X4 -> Next. The same ordinary build must then leave
   all three stamps current and support the actual emitted source/ABI audit
   and installed runtime. Do not add a special proof-only build path.
3. **Inherited compatibility audit rejects registered siblings.** Preserve
   the original verifier failure at the initial 294921a source. The repaired
   verifier must require exactly the registered additions, including every
   original X3 operation. Existing paths, enum order, named schemas and frozen
   acceptance digests retain the original checks. Each changed operation enum
   must contain the exact complete registered extension, without duplicates
   or missing operations. An unregistered addition must not be accepted merely
   because it shares a prefix. Report each family's additions separately.
4. **A proof uses the wrong build, weakens limits or inserts terminal state.**
   Source stamps and actual trace/native dependencies must match the current
   worktree. Use real authenticated/native owner paths and provider readback.
   Existing fault/recovery/effect and numerical oracles remain unchanged.
   No directly inserted successful model, promotion, Work outcome or provider
   postcondition qualifies as runtime evidence.
5. **Historical evidence is silently relabelled current.** Historical
   manifests/archives remain unchanged. Every new run has a fresh evidence
   directory and exact command/source identity. An old PASS stays attributed
   to its old cut; changed source requires the affected proof.
6. **Unknown X1/X2 contracts are guessed.** Copying handoffs without source,
   unreadable paths or a source seal without execution does not establish
   engineering completion. Inspect actual contracts, original pending work,
   migrations and source custody before integrating them.

## Evidence and interpretation

Capture the initial compatibility failure, old-build/stale-X4 failure, read-only
negative/positive stamp checks, fixed ordinary build, generated/type/lint
checks and current-cut installed/mounted results. Retain exact exit codes and
failed commands as failures, even when they establish an expected negative
boundary. A later repair receipt does not rewrite its predecessor.

Register additional integration/peer failure contracts before their code changes
once the genuine X1/X2 packets are available. Protected qualification and business
completion must use independent original oracles, not this compatibility tool.
