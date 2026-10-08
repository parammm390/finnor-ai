# Completed-source release, failure model before integration

This candidate starts at published S7 `d8d72f8f37f20761e7cd7d8517b80acaa124115a`.
Actual main is `ed32d200a9459269509f1e40d4e13a3e2a1a4d6a`.
The eight current drafts are cleanup108 and S1–S7 109–115, not eight uncommitted
independent releases. No shared/active checkout is changed.

## Decisive failures

1. **Wrong source or duplicates.** A branch name, copied working tree or green
   ancestral CI run does not identify the final combined source. Pin commit/tree,
   patch preimages, dependency locks and every source export. Preserve the
   existing PRs; do not publish duplicates or rewrite their histories.
2. **Active work accidentally included.** Exclude current M5 DecisionKernelCompiler
   and P8/M6 HarnessEvolution. Do not import their mutable checkout/phase records,
   protected deltas or source proposals. Import only explicit completed producer
   identities and verified S8 source pins. A changed pin stops import.
3. **Integration conflict.** Rehearsal already finds `finnor-os/package.json`
   conflicting between S7 and cleanup. Preserve S7 fs-ext/security patches and
   cleanup's actual removals. Resolve manifests and locks together; do not choose
   an entire obsolete dependency graph to silence a conflict.
4. **Migration collision/history mutation.** Maintain every already published
   SQL body and registry order. Reconcile B/C histories from real receipts and
   allocate unnumbered proposals only once. Verify bundled/head metadata and
   rehearse interrupted upgrade before production.
5. **CI not testing the intended code.** Stacked bases and stale duplicate check
   runs require exact head/run identities. New producer harnesses must actually
   be included by the final release gate. A skipped/missing suite is NOT_RUN,
   not PASS. Preserve original meaningful guards and record expectation changes.
6. **Repeated expensive blind reruns.** Before integration tests/builds, run
   syntax, dependency availability/lock consistency, generated contracts,
   migration parity and backend/root types. Preserve failing output. Rerun only
   an affected boundary after a diagnosed change, then one full final corpus.
7. **False evidence reuse.** Source pins and sanitized views are distinct from
   original product digest preimages. Historical native/mounted passes remain
   historical after a source change. Verify the actual combined candidate.
8. **Unqualified mechanisms exposed.** Ordinary proposed/SHADOW functionality
   does not authorize protected search, signing, effects or independent admission.
   Keep S6/S8 fail-closed. Do not fabricate BASE10, billing, host attestation,
   prospective value, canary exposure, private keys or evaluator signatures.
9. **Known engineering red disguised as external.** B retains a repo-owned M3
   authentic-P4 repair-child deadline failure; C retains two P1 assertion/port
   failures. Reproduce and resolve them in this owned candidate before claiming
   those implemented domains release-ready. Independent field gaps are separate.
10. **Disk, clocks or worker preparation.** Only 3.1GiB was free initially.
    Reuse verified exact installed dependencies without modifying their sources;
    do not duplicate large caches or delete peer state. Record real preparation.
    Bounded wake assertions cannot renew product grants or hide cold failures.
11. **Secret/credential publication.** Use configured credentials only as intended.
    Never write them, `.env`, raw claim/execution keys, protected ledger keys or
    customer data into commits, logs or PR bodies. Scan the complete proposed
    diff and preserve authorized evidence-redaction receipts.
12. **Premature production.** No main push/deployment while the combined candidate
    has conflict markers, missing applicable checks, unadopted migrations or
    unresolved engineering failures. Post-merge exact-SHA certification and the
    canonical guarded deployment own production. No direct console shortcut,
    branch-protection bypass or isolated component deployment is acceptable.

## Workflow

Inventory once; pin source/dependencies; rehearse conflicts without changing peer
trees; integrate explicit boundaries; run cheap static gates; resolve actual
failures; run affected real trajectories; review the complete staged diff; commit
and produce complete draft PR descriptions; then perform the final combined
release checks. Deployment is the last step, conditional on readiness, not a
way to discover missing prerequisites.

## First joined-source keeper replay, before repair

`c-p6-keepers-01/results.json` retains 700 passing assertions, one failing
assertion and failed collection at the existing worker-boundary suite.

- The existing Mistral response omits its returned model. C adds an optional
  `returnedModel: null` key to the legacy usage object, breaking its exact shape.
  Omit only this absent optional key; a supplied returned model must remain
  observable and missing identity must stay unknown. Do not change token counts,
  caller deadlines, provider routing or the existing assertion.
- Vitest's bare private-equity alias consumes the new deep worker imports and
  appends them to `src/index.ts`. Add the actual candidate-owned source-directory
  alias before the bare alias, like the existing DB subpath handling. Do not mock
  the handlers, skip collection or modify the worker-boundary assertions.

Re-run those unchanged suites first, then all existing keepers. The denominator
must recover the missing assertions; 700 passes alone are not a green corpus.
The first narrow replay passes all five routing assertions, then exposes the
same bare-alias problem at `@finnor/db/compute-governor`. Register that real DB
subpath too; the worker controls remain unchanged.

The second narrow replay collects all ten assertions. Its only failing assertion
is the existing Phase-5 registry snapshot (`16`) versus the actual `17` intents.
Both current release verifiers already require 17, specifically the existing
16 Core/PE intents plus `harness_program_v1`. Refresh only that old snapshot
literal. Do not remove P1, add a mock or alter any retired-vertical, worker,
source-mapper, authorization or scheduler assertion. No new unit test is added.
The final native P1 query trajectory remains a separate required check.
