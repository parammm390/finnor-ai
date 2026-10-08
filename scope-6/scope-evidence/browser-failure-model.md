# Browser settlement and egress failure model

Recorded before S6 browser test/source changes, 2026-10-02.

Owning boundary: `ComputerRunner.run` decides whether a concrete WRITE business effect becomes reconciled and whether the parent DomainAction becomes completed. `finalizeComputerRun` persists the decision and propagates it to BusinessEffect and receipt owners. Generic StructuredPageObservation currently supplies only page URL/title/text/controls, with no qualified target/account/field/version readback. Steel uses Playwright/CDP and an ordinary authenticated application profile.

Material failure cases:

- The target identifier appears in a navigation/sidebar record while another record contains the requested field value; page-wide containment falsely settles the target.
- A requested null clear is accepted without observing that field or its explicit cleared state.
- Empty change maps, stale pages, partial batches, unrelated records, provider acknowledgements, executor success and planner assertions substitute for business post-state.
- A decision labels a click/type/press/visual primitive `act`, escaping the runner's `effect` interception and possible-egress recording.
- WRITE initial navigation or arbitrary application requests mutate before any effect-bound admission. Origin allowlists cannot bind the account/record/request semantics.
- READ_ONLY allows off-origin fetches, side-effecting GETs, WebSockets, service worker traffic and uncontrolled sensitive data egress; it is retained as legacy bounded behavior, not admitted protected execution.
- A worker dies after a possible UI dispatch; recovery observes unrelated text and destroys an unresolved obligation by claiming success.
- An observation error falls back to a previous observation. Generic text is never sufficient settlement evidence.
- Revocation after preflight, provider acceptance before local receipt, external provider ignores local fence, and app/profile changes may leave possible effects. Revocation/cancellation cannot undo them.

Implementation domain: generic browser WRITE has no qualified protected egress/observation contract and is unadmitted. New WRITE must fail before provisioning/navigation or primitives. Recovery of an already dispatching/unknown browser WRITE may collect generic observations but must preserve unresolved external operation, BusinessEffect reconciliation requirement and responsibility. No stronger claim is derived from adapter flags. Generic observations cannot establish null clears or any WRITE settlement. READ_ONLY behavior remains bounded by its existing controls; full sensitive-read egress confinement remains unsupported.

Threat model: untrusted decision engine can relabel operations or substitute observations; generic authenticated pages and arbitrary provider implementations do not supply an independent protected verifier. Existing application roles, database RLS, FINNOR authority owner and ordinary runtime are inherited assumptions, not hostile code confinement. There is no separate protected browser release/admission owner available in this path.

Validation: extend the existing real-database ComputerRunner integration suite. Persist independently known preexisting unknown operations as recovery inputs; runner must create its own reconciliation/terminal records. Regression expectations are independent: intended target field is unchanged/non-null despite unrelated matching page text. Pre-fix must return succeeded and mark external operation succeeded (the forbidden behavior); after repair it must return blocked and retain unknown/open reconciliation. Test providers are controlled generic observations, not live provider or confinement evidence. No fixture supplies the receipt or settlement under test.

Budgets: existing run limits (5 primitives, 60 s, 5 provider credits, 5 artifacts, 16 KiB result) in disposable integration fixtures. Regression cases run within these limits; unknown recovery never re-dispatches a write. Artifacts retain source digests, exact inputs, actual terminal/state observations and rerun commands without credentials. No economic/frontier value claim.
