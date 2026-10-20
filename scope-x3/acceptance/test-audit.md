# Independent test audit and custody

## Audit standard
An acceptance check must expose an observable contract, kill a credible defect,
have a nonduplicate strongest owner boundary, and compare to an independent
literal expectation. A wrapper, renamed fixture, or import of candidate business
functions supplies no independent evidence. No unit tests are supplied here.

| Case group | Observable contract / credible defect | Strongest nonduplicate boundary | Independent expectation |
|---|---|---|---|
| exact-match, one-minor-mismatch, sum-overflow, invalid-* | exact sums/encoding; Number rounding or parser coercion | canonical record write + DB readback | literal delta, state and denial codes |
| currency-mismatch, inr-match, eur-r1-denied, eur-r2 | currency-qualified match; hard-coded USD/INR or FX netting | compiled application record command | same digits in different currencies denied; EUR versioned |
| unknown, stale, conflict, refresh-after-approval | epistemic state; unknown promoted or pins overwritten | S1 source/currentness owner + application readback | no advancement; old pins retained |
| high-approval, low-approval, threshold-equal, compliance-first | inclusive thresholds and role ordering; off-by-one/one-role bypass | durable approval owner | exact approver set and final state |
| self-approval, self-dual-role, same-principal, wrong-role, wrong-scope, wrong-tenant | real principal separation/scope; client role spoof | canonical identity/authority + command owner | deny unchanged state, no foreign read |
| revoked, record-precondition, approval-record-precondition, prepare-record-precondition, commit-race | current authority/revision at commit; TOCTOU | actual atomic authority/record commit | no proposal and no execution |
| prepare-retry, execute-refused | proposal vs dispatch; duplicate or accidental execution | FINNOR durable proposal/queue/effect owner | one proposal, zero execution across restart |
| revision-retains-original, release-retains-original, inr-retains-original | immutable historical meaning; automatic migration | canonical persistence + fresh-process readback | original USD/INR lines/refs/release/state retained, new revision DRAFT |
| manifest A/B/I | general synthesis, browser use and fault containment; fixed demo | actual compiler/caller/owner integration | independent second declaration + real artifacts, NOT_RUN |

`reference.py` is an executable mathematical/business oracle, not installed
acceptance. Its own literal-check success is only consistency evidence; it cannot
certify its own model assumptions or any candidate implementation. The manifest
keeps every installed/canonical-owner observation NOT_RUN. No fixture contains
approved-state seeds, fake canonical effect receipts or mocked success callbacks.
Expected approval bindings/proposals are model observations, not owner evidence.

Custody: independently authored development material within the assigned acceptance
folder. No secret holdout, blinding, protected evaluator, independent human signoff,
budget accounting, measured model provenance or cost custody was supplied.
Those facts remain UNKNOWN, not zero or implied by the use of another worker.
Historical R/X, X1/X2 or unrelated test receipts cannot be credited to this profile.
No owner source, product code, canonical schema or external system was modified.
No commit, deployment, execution or business effect is authorized by this packet.

To install later: freeze-check byte hashes; confirm owner policy and A–J crosswalk;
bind an external driver to real canonical boundaries; record exact inputs,
selection census, release/reference bindings, observations, restart/fault evidence
and artifact digests; compare with these literal projections. An adapter must not
compute its own expected success using candidate functions. Any missing owner or
artifact remains NOT_RUN/UNKNOWN. Separate protected gates remain separate.
