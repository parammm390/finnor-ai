# S5 targeted supplemental authoring gate

Recorded before adding these owner-boundary cases. The original benchmark cells,
expected objectives, cash constraints, budgets and exact/numerical scoring stay
unchanged. The failed first-run artifacts remain. Supplemental cases exercise
distinct canonical resource semantics already included in the chosen domain.

| Case | Observable contract | Credible breaking change | Existing gap | Test-only production seam? |
|---|---|---|---|---|
| Signed-covenant contingent lower envelope | A negative coefficient on another pending contingent commitment uses its minimum supported consumption, never its independently maximal envelope | Charge debt60 minus maximal cash40 instead of minimum cash20, falsely passing covenant30 | Original optionality case has only positive cash constraints and a constant joint envelope | No. Real S3/S4 policies, actual owner clearing twice, immutable SQL readback and independent Fraction oracle |
| Flow/stock/class/terminal debt | Two dated payments60+60 fit separate flow periods100 but cannot spend stock100; terminal liability10 on stock spend95 refuses at terminal; borrowing headroom is not cash even with USD units | Use one scalar total for flows, forget prefix/terminal usage, accept unit alone as economic interchange | Original timing case checks an inflow and existing debt, not these distinct resource meanings | No. Register actual resource identities, explicit owner mappings and fixed S4 policy revisions, then clear through real API |
| Scope restriction | Same-tenant/owner/unit resource cannot finance a policy outside its explicit permitted entity roots | Drop legal/entity restriction while retaining tenant and unit checks | Original foreign-tenant check protects tenant crossing; it cannot establish same-tenant restricted resource scope | No. Supported resource registration with explicit permitted roots and the actual issuer/checker boundary |

First-run failures are fixture/validity failures: periodic synthetic residuals
were correctly falsified by S3's serial-dependence diagnostic; a 15-second
certificate expired during the repeated real handoff readbacks and correctly
withheld clearance. The synthetic law is changed to the existing independently
generated nonperiodic noise; lifecycle validity is 45 seconds so the intended
consumption boundary precedes a real wall-clock expiry. These are not production
safety regressions, and neither changes the registered optionality cash envelope,
portfolio expectation, decision deadline, risk floor or optimization scoring.

Regression extensions before the final rerun: certificate ordering/readback must
be stable across policy-ID order and JSONB object-key order. Credible break is
byte/array ordering confused with semantic identity; earlier positive issue
coverage did not prove stored optional branch/cost readback. Extend actual owner
read and public certificate verification; no test-only interface. Retained run
23-12-29 records the branch-key failure and run23-21-23 the opportunity-cost
failure. Every intended positive release must assert successful RELEASED before
the next allocation; this prevents an unrelated retained hold masking the next
constraint challenge. No input, expected allocation or coverage is removed.

Atomic experience integrity extension: each durable reservation/consumption has
one canonical transition event. Credible break is owner/store duplicate appends
or post-commit event failure reported as allocation failure; prior checks only
asserted some event existed. Extend independent SQL readback, no production
test seam. CodeRabbit finding1 and retained pre-repair SQL readback establish
the duplication before repair. Retried semantic reads return the same consequence.

Bounded registry authoring gate before boundary extension: (1) the ordinary
resource owner must reject the17th new resource atomically while16 remain readable
and existing revisions remain possible; (2) a limit checked only after insertion
strands the registry; (3) existing stressed demand used5 resource pools and did
not reach the registry boundary; (4) no production test seam, call the actual
resource API and read the registry with the ordinary role. The same insertion
preflight must protect the256 live commitment bound; existing independent
concurrency/abort proof owns mutation atomicity rather than duplicating hundreds
of empty-programme solves. Maximal256-load performance remains unmeasured.
Focused reruns may select named owner cases through test support only. Such an
artifact explicitly records the selector and cannot substitute for the full run.

Currency assertion extension before the final run: observable contract is identical
canonical monetary unit/currency with no conversion; a USD quantity labeled EUR
can otherwise hide unsupported netting. Earlier class/scope cases did not vary
currency. Extend the existing registry owner scenario before filling capacity,
using a current authorized input and independent API refusal. No new production
seam. This is a new adversarial input; no pre-repair safety regression is claimed.

Late handoff persistence authoring gate: the actual S4 path must persist all
fallible preparation before S5 intent, so a post-intent file-write failure cannot
lose the handoff response or its preparation evidence. Credible failure: the
current code writes the HANDOFF record after durable consumption. Existing
SIGKILL-after-success does not reach a failed final file write. Extend that same
owner scenario with a real SQL pause after consumption INSERT, observe it from
pg_stat_activity, make the existing S4 event directory read-only, then read the
actual child response and ordinary SQL. No production fault flag/export/mock.
The expected response succeeds after preparation was durably saved; the pre-fix
source must fail at EACCES. Directory modes/triggers are restored in finally.
A focused pre-fix run temporarily uses the retained pre-guard S5 store, with no
source edits while the child runner is executing, and restores the current store
after subprocess completion. This corrects the earlier registry fixture failure:
run23-58-46 never reached insertion because it omitted an actual S4 policy and
is explicitly not evidence of the intended registry regression.

Final review extensions, recorded before their tests or repairs:

| Owner challenge | Observable contract | Credible failure | Prior gap | Test-only production seam? |
|---|---|---|---|---|
| Cold exact certificate read and concurrent registry read | Original certificate proof is checked without blocking unrelated owner I/O; a bounded worker failure refuses verification and retains responsibility | A cache miss runs the whole subset proof synchronously on the API event loop | Earlier cold read has only a small portfolio and does not exercise the complete14-policy proof | No. Actual issued14-policy certificate, real authenticated read/resources operations, timer delay and complete readback; no injected production delay |
| Reconciliation after terminal native history | Pending S5 intent remains readable/reconcilable when more than256 unrelated terminal native effects exist | Count all historical native effects against the open-effect readback bound | Earlier unknown case has no native history | No. Generated explicitly unrelated terminal native records are fixture data; actual owner reconciliation must retain unknown S5 exposure and claim no settlement |
| Infeasible independent solver reference | Real infeasible original constraints produce an explicit no-solution result and no upper estimate or reservation | `math.isfinite(None)` crashes the separate reference | Earlier numerical-margin empty selection is feasible | No. Actual issued canonical inputs plus an explicit owner-supplied require-selection constraint, actual clearing refusal and independent reference command |

The cold-read challenge uses one common path, one period,14 fixed policies with
unit demand/value, cash100 and the same30000ms owner budget. This is an operational
challenge, not a replacement for the registered coupled16-firm stress/scoring.
The read interval starts after issuance; expected maximum event-loop delay is500ms.
Its source and actual elapsed read/proof/registry results are retained. A failed
pre-fix run must reach this timer/complete-proof boundary before it counts as a
regression. The existing original S4 forged-reference case remains unchanged and
owns the BLOCKED_ALLOCATION compatibility contract.

Worker failure model before isolation: missing/incompatible bootstrap, bad IPC,
oversized input, exhausted proof deadline, worker crash, saturated two-slot pool,
or cold proof unable to complete must refuse the read with accountable SQL state
unchanged. Only pure original mathematical verification runs in the worker; live
source/rights/principal/resource checks remain with their owners. Idle workers are
unreferenced; a terminated worker cannot free its slot until actual termination.
No protected admission or worker-produced execution authority is introduced.

Fault-harness hardening: require an actual non-root uid before claiming that0500
prevents writes. Record and verify the preparation already exists at the externally
observed consumption boundary. Restoration attempts dropping the trigger/function
even if chmod restoration fails. The review suggestion to assert that the prepared
HANDOFF event is absent conflicts with the repaired preparation-before-intent
contract; the correct assertion is durable preparation before intent, with its
consumption still null and explicit preparation qualification.

Fresh review6 clearing-liveness extension, registered before its test or repair:
the same14-policy owner challenge also measures the interval around the real
clear request. Observable contract: bounded certification preserves unrelated
owner I/O during clearing as well as readback. Credible failure: the numerical
child is asynchronous but `certifyAllocationOptimization` still enumerates all
subsets on the API event loop. Existing cold-read timing starts after issuance
and cannot detect that stall. Extend that same real owner case with a20ms timer
and unchanged500ms maximum delay before clearing; no production injection seam.
Retain authentic pre-repair failure, then use the identical original checker in
the two-worker pool for certification with the remaining whole-owner deadline.
The original coupled16-firm scoring and all registered decision budgets remain
unchanged. Worker failure refuses new commitment and preserves existing holds.

Fresh review7 responsibility-state extension, registered before test/repair:
observable contract is that a later lawful intent in a reserved compatible
programme cannot downgrade an earlierUNKNOWN_OUTCOME. Credible failure: every
node insert writesCONSUMPTION_PENDING, downgrading the reservation after
reconciliation. Current source inspection corrects the earlier summary: the SQL
trigger enforces consecutive projection revisions, but does not yet reject a
responsibility-state downgrade. Existing optionality has no consumption and the
unknown case waits to expiry without later intent.
Extend the existing real P/Q optionality owner case: reconcile the first intent
as unknown, then consume the second actually selected compatible policy and
assert the same100 envelope andUNKNOWN_OUTCOME projection remain. No new
production fault seam, fake receipt or settlement fixture. The pre-fix source
must fail on independently observed UNKNOWN_OUTCOME becomingCONSUMPTION_PENDING.
Repair the owner and enforce immutable projection identity/envelopes plus legal
responsibility transitions in the new, undeployed0148 migration. Original146
migrations remain unchanged; projection history still appends consecutive revisions.
Resolver read duplication is a performance/consistency repair within this same
owner, covered by the actual branch/consumption paths; add no duplicated test or
test-only API. Private validation can return its verified issued value internally
while the publicvalidate response shape stays unchanged.

Storage protocol extension before authoring: (1) actual ordinary-role SQL cannot
shrink a committed envelope or downgrade an unknown reservation/consumption;
(2) an omitted projection guard otherwise allows those updates despite immutable
origins and consecutive history; (3) positive API history does not exercise a
malformed projection write; (4) no production seam, use the existing tenant
transaction and actual persisted optionality programme. Successful forbidden
writes deliberately throw inside the transaction so the negative control always
rolls back; record the actual guard error or allowed-write signal and require the
specific responsibility/envelope boundary. To establish pre-fix failure safely,
temporarily use the retained original0148 plus regenerate its bundle, run only
this owner case, then restore current0148/bundle after the runner terminates.
Do not edit source/test while it runs. This is ordinary storage correctness,
not a claim that an app tenant setting is a cryptographic capability or protected
history. No original migration or upstream evidence is overwritten.

Fresh review8 repeated-reconciliation extension, registered before test/repair:
observable contract is that every new pending intent is assessed as unknown
when reconciliation finds no qualified S6 outcome, even when aggregate status
was alreadyUNKNOWN_OUTCOME. Credible failure: per-consumption updates are nested
under the aggregate transition and skip a later compatible intent. Existing
first reconciliation cannot catch that lifecycle gap. Extend the same P/Q owner
case with a second actualreconcile and ordinary SQL readback requiring both
consumption projectionsUNKNOWN_OUTCOME, with aggregate revision/envelope retained.
No new test owner, production seam, receipt, authority or settlement input.

Upstream result-wrapper correction before edit: original S1/S2/S3 explicitly
emitPASS_LOCAL. Observable contract is that nonempty unchanged owner cases allPASS
and process0 qualify local replay, without promoting their full frozen gates.
Credible failure is a generic top-levelPASS-only parser rejecting valid original
local status. Existing initial wrapper checks used`cases`/`results` correctly but
did not exercise this exact label. The authentic rerun has all positive rawcases
but wrapperexit1. Accept exactPASS/PASS_LOCAL metadata while retaining all failure,
empty/missing and process checks; no production API or unit test. Rerun the same
unchanged owner commands with their original budgets.

Repository failure isolation before replay: default original CI backend tests
failed after S5 while migration/planner/provider-budget proofs passed. Credible
causes include a new S5 source/migration regression, inherited S1–S4 dirty changes,
or this local environment's unsupported assumptions. Preserve the full failure;
compare the identical original default command in a fresh disposable database
with actual start-source copies for S5-touched upstream files, S5 route/0148
quarantined and recorded initial migration head0147. New S5 standalone modules
are unreachable from restored barrels. The exact initial head file bytes were
not saved; only its independently recorded0147 value is restored, explicitly
qualified. Restore current files/bundle after terminal runner completion and
verify their hashes. Do not edit tests, suppress failures, broaden source changes
or claim full CI from focused owner passes. This is retained original coverage,
not newly written unit tests or an invented product seam.

Repository driver terminal-state extension before repair: (1) every failed child
command must make the wrapper fail and terminal evidence must record cleanup;
(2) an already exited embedded PostgreSQL leaves `stop()` awaiting an exit event
that cannot recur, and its inherited async-exit hook can return process0 before
the final summary; (3) existing command metadata correctly recorded failures but
did not prove the outer exit/cleanup outcome under a crashed database; (4) no
production seam or new unit suite, replay the same actual existing repository
commands and qualify their individual terminal results. The baseline isolation
artifact records backendexit1 but wrapperexit0, with actualENOSPC and incomplete
cleanup. Preserve it as a test-support regression, not a passing baseline.
Bound cleanup using the owned embedded child process's actual exit/signal state;
remove only the known private disposable directory after confirmed termination.
Persist terminal status and flush output before explicit process exit so a
third-party beforeExit hook cannot convert failure to success.

Fresh support review11 readiness extension before repair: observable contract
is that repository evidence uses the actually owned disposable Redis process;
a credible failure is an exited child followed by a successful socket connection
to another listener in the free-port race. Prior normal startup proves no such
failure and cannot justify claiming a pre-repair regression. No new unit test,
production injection seam or external listener is added. Check the owned child's
actual exit/signal state before polling and again before accepting readiness,
then retain the same original repository replay and its service/cleanup evidence.
The source edit waits until the current original CI runner terminates.
