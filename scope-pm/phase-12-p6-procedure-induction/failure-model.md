# Failure-first isolation and integration model

Written before production changes. Primary proof is end-to-end, with independent
inputs/expected values and repeatable artifacts. No post-code unit tests.

| Boundary | Credible failure | Required behavior / evidence |
| --- | --- | --- |
| Decode | Deep/cyclic AST, prototype keys, huge numbers/payloads | Bounded iterative decode before recursive validation; strict keys |
| Authentication | Forged token, asserted principal/tenant headers | Actual bearer authentication and user lookup; no leaked history |
| Episode rights | Foreign company/Work/principal, revoked source access | S1 resource/source authorization at read and before publication/use |
| Universe | Only winning requests selected inside an episode | Enumerate whole original episodes, including failures and unknown paths |
| Knowledge cut | A later correction or terminal head replaces earlier knowledge | Immutable visible records at explicit cut; future adverse notices separate |
| Custody | Ordinary SQL/fixture mistaken for protected ExperienceLedger | Source qualification stays explicit; protected analytical feed refuses |
| Source text | Malicious instructions select tools or execute code | No instruction-text induction or raw-code input |
| Structure | Same words but different operations accepted | Match AST dependencies, types, acceptance and failure invariants |
| Identity | Firm, record, amount, period, tranche accidentally constant | Generalize only explicitly bound identifiers; no fuzzy record matching |
| Aliases | Duplicate source/output names, colliding field mappings | Unique role mapping, exact current schema; no guess based on names |
| Parameters | Unused required source, missing/null value interpreted as zero | All material sources consumed; unknown remains blocked |
| Rates | Monthly treated as annual, percent treated as fraction | Frequency/scale/convention are invariants; mismatch refuses reuse |
| Fees/date | Closing fee vs future fee, wrong calendar/day count | Branch/literal/calendar/instrument contracts retained |
| Finance | Mixed currency/sign/consolidation, unsupported instrument | Exact semantic binding or fresh admitted/ordinary synthesis, never inference |
| S3 | Computation treated as identified customer-response transport | No S3 claim/admission without owner evidence |
| Arithmetic | Zero division, repeating ratio, exponent/precision overflow | Bounded exact arithmetic failure retained; no fabricated rounding |
| Composition | Core accepted but residual drops liabilities or required inputs | Independent check of original whole P1 acceptance and artifact |
| Module | Rehashed modified JS/IR/compiler/library admitted | Rebuild registered finite emission; exact archive/source/runtime pins |
| Isolation | Generated module sees DB/credential/files/network | Existing S6 isolated execution only; no trusted-host evaluation |
| Resources | Loops/cycles, step exhaustion, response/episode expiry | Finite AST; original P1 grant/deadline, no renewal by selection/fallback |
| Admission | Null/forged/expired/mismatched revision accepted | Fail closed; current S8 ProcedureCapsule port unavailable |
| Lifecycle | Counterexample changes module in place, old admission survives | Immutable linked notice; dependent uses invalidated; new capsule revision |
| Race | Selection races counterexample, rights or Work revision | DB locks/fences and recheck before result publication |
| Recovery | Crash after capsule commit duplicates capsule, loses attempts | Idempotent immutable bytes, native queue leases; retain incurred costs |
| Fallback | Cached old answer labelled fresh fallback | Real P1 execution on current sources, actual new isolated receipts |
| Cancellation | Cancelled work emits a result or auto-restarts | Fence request, no subsequent publication; costs retained |
| P5 | Capsule succeeds while effect remains UNKNOWN | P5/S6 observation and reconciliation retain authority |
| Economics | Runtime/token savings reported as attributable owner wealth | No economic result, causal credit or unmeasured dollar claim |
| Integration | Proposed SQL/patch mistaken for adopted cumulative release | Overlay evidence separate; serial owner successor required |

## Test authoring rationale

One primary story owns each contract. The native story owns authorization,
custody, abstraction, composition, fallback and lifecycle across real
PostgreSQL/queue/Work/isolated boundaries. A separate physical child story owns
restart/crash behavior that a same-process invocation cannot establish.
Independent SQL/Fraction expectations use business arithmetic, not product
helpers. Existing P1/P4/P5/P7 stories protect unchanged owner behavior. No mock
supplies the admission, capsule, acceptance result, persistence or callback
ordering that the product must produce.

Preimplementation import/route failure will be retained. Later failures get
fresh run directories. Never overwrite a failed run to make a final report
green. Test cases added as required by this prewritten model remain integration
stories, not implementation-coupled unit tests.

## Observed crash-window refinement, before the next native rerun

Native05 omitted the native recovery sweep. Native06 included it and showed
the queue's existing first-recovery backoff is 60 seconds, longer than P6's
accepted 30-second induction grant. Do not remove that backoff, renew the grant,
or require a new capsule after expiry. The before-publication physical SIGKILL
must recover to a retained FAILED induction with no capsule, the same original
deadline, retained original synthesis attempts and a charged recovery delivery.
It must not synthesize again once its grant expires. A separate physical after-publication/before-
delivery-acknowledgment SIGKILL must replay the durable already-TESTED induction
without a second capsule or a renewed synthesis attempt. Both use actual table
locks, a killed child worker and the native lease/recovery/delivery records.

The acknowledgment window also interrupts its actual blocked PostgreSQL
connection before releasing the lock. A killed client alone can leave an
already accepted SQL acknowledgment free to commit, which is legitimate but
does not exercise replay. This is an explicit worker-plus-transport-loss
failure, not a fabricated job state or permission to blindly repeat an effect.
