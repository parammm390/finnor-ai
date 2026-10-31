# W3 whole-shape design decision

## Observed callers and semantic owners

| Call | Existing boundary | W3 responsibility |
|---|---|---|
| Authenticated original intake | apps/api/lib/auth.ts; db.receiveWork / work_inputs | A separate explicit service contract, never inferred from a read |
| Current facts and rights | evidence_sources / evidence_source_versions; authority employeeAuthoritySnapshot and canExerciseAuthorityTx; P4 source revisions | Resolve exact source versions and purpose; keep assertions distinct from world truth |
| Durable programme | canonical works / Work events; Postgres JobQueue with job_delivery_attempts, token/fence/lease | Persist typed immutable W3 artifact and per-Work coordination metadata |
| Resource feasibility | enterprise-allocation and S5 reservation/consumption/frontier | Read and consume the original owner, never issue a W3 allowance |
| Consequential effect | enterprise-obligations compile/schedule/execute/readback; governed-execution broker | Bind exact service terms to original fixed S6 identity; retain UNKNOWN and liabilities |
| Participant / inspection | authenticated actual users and immutable S1 evidence; S2/S3 observation contract | Purpose-limited scoped invitations and self-authored reports; never invent humans or competence |
| Accounting | enterprise-economic-attribution S7 records | Link original costs, actual quantities, invoices and uncertainty once; no alternative financial court |
| Mounted product | WorldWorkRecord and existing private-request scope | Extend original Work, not create another dashboard |
| Admission | actual S8 method/release authority | Development checks grant no admission or field authority |
| Invalidation | source revisions, authority and current owner rows | Fence the smallest dependent service closure; retain historical work and unsettled costs |

## Candidate A: declarative service/observation graph

Compile a complete immutable service-instance graph from the original OutcomeContract and current S1 provider evidence. Every instance has exact site/local-date/offset-window/quantity, original hard criteria, alternative eligible provision, readiness and independent observation requirements. A separate checker reconstructs coverage from the original contract. The native Work consumer selects eligible actions from this checked graph and schedules existing S6 identities; source/participant events wake the same canonical queue. Projection state is derived, not a second provider/effect/finance truth store.

Strengths: complete 3-site/30-day coverage is independently enumerable; exact-terms and evidence predicates are explicit; changed provider facts only affect their dependent instances; original missed work and all residual identities survive. Installed bytes and independent original-input mutation checks have a small surface.

Costs: immutable artifact revisions and currentness cut must be checked again at use/dispatch; it cannot claim physical truth from graph correctness. Matching uses a bounded deterministic search and reports exhaustion rather than infeasibility.

## Candidate B: service-state event controller

A controller owns accepted/ready/started/delivered/inspected/disputed/missed/cancel-requested/cancelled/operational/financial state and emits per-service S4 commands while dynamically rebuilding continuation.

Strengths: direct exception handling; natural time-based retry and backup scheduling.

Costs: duplicates existing durable workflow state unless every transition is carefully delegated; complete original-instance coverage and absence of stranded terms are harder to audit; currentness and financial/effect truth can split across controller and owners. Larger recovery/compatibility surface and more hidden assumptions.

## Chosen shape

A. Immutable producer/checker graph plus a thin owner-bound native consumer. Domain projection remains an observation of canonical events, not an alternative workflow, grant, provider or accounting engine. No independent W3 dispatch client is introduced.

## Caller-first interface sketch

```ts
submitServiceOutcome(ctx, { workId, outcomeSource, providerSources, parentAllocation, parentPolicy })
runRealWorldServiceJob(payload, nativeClaim)
checkServiceProgram(originalOutcome, currentOwnerEvidence, candidate)
consumeServiceProgram(ctx, { requestId, expectedArtifactDigest })
submitServiceObservation(authenticatedReporter, { invitationId, termsDigest, evidence })
readServiceWork(ctx, { workId }) // private, complete coverage or an explicit gap
```

Boundary schemas are strict. Internal types use discriminated variants for evidence, commitment, uncertainty and closure rather than optional-state bags. Source handles refer to immutable S1 bytes; participants author their own evidence. An authenticated report proves authorship, not delivery, sensory truth or professional qualification.

## Local integration custody

This isolated W3 branch has one serial writer. No W1/W2/global integration owner has acknowledged a shared revision. Local shared-file deltas are reviewable preimage-bound integration candidates, not an assertion of peer adoption. No peer worktree is written.
