# W1 whole-design decision and caller-first contract

## Alternatives compared before implementation

**A, complete-state contingent policy with measured-response compilation.** One policy graph carries computation identities, observations, context/dependency edges, verification and stopping. The finite supplied-model profile uses exact continuation values and a separate original-byte reference. Empirical observations fit joint treatments, not additive agents; their conditional estimates and uncertainty compile into the same execution representation. Existing native dispatch consumes the selected node; S5/S6/S7/S8/P7 keep their ownership.

**B, receding-horizon contextual controller with a separate exact-profile solver.** A bandit/MPC loop selects the next computation from learned marginal response and keeps a separate exact demonstration path. This is cheaper for broad unstructured catalogues but needs extra state/interaction handling to recover complementarity, lacks a complete-continuation certificate, and risks two production engines or a demonstration optimizer disconnected from the consumer.

**Select A.** The original contract needs nonmyopic complementarity, explicit observation-contingent topology and independently checkable continuation. Exact arithmetic already exists in `packages/epistemic-runtime/src/r2-rational.ts`; canonical query and objective ownership already exist in orchestration. Reuse those primitives. This is an architectural choice, not a measured superiority claim.

The 64-state/16-choice/8-decision limits apply to the first exact-reference profile, not total production scheduler capacity. Larger empirical work uses the native remaining-budget controller with honestly incomplete search and a compatible checked incumbent. It is never truncated and relabelled exact.

## Caller-first shape

```ts
const model = parseMetalevelModel(originalModelBytes);
const policy = compileMetalevelPolicy(originalModelBytes);
const checked = checkMetalevelPolicy(originalModelBytes, policy);
// At each real time/trust boundary, the native consumer resolves current pins,
// preserves the original Work/grant/effect identity, then dispatches the choice.
// An observed token selects the corresponding continuation, not a fixed panel.
```

The pure exact kernel owns only a proposed contingent computation policy. It does not reserve, grant, dispatch effects, accept business results or promote itself. The native adapter must bind the complete original Work/outcome/mandate/deadline, actual admitted catalogue and measured-response revision before any proposed choice can execute.

An independent Python Fraction reference reads the same *original bytes* with its own parser and recurrence. The production checker does not import producer selection helpers. Both preserve all optimal choices and select only by the original total tie order. Model-relative exactness is not empirical transport, protected custody or admission.

## Owner-grounded facts and current integration

- `orchestration/src/instruction-routing.ts` owns QUERY/ATOMIC_EFFECT/OBJECTIVE/CONVERSATION; no replacement route scheme.
- `orchestration/src/index.ts:640–768` handles deterministic reads before memory/planning and starts existing objectives for owned outcomes.
- `orchestration/src/fast-read-lane.ts` and `operational-query-runtime.ts` remain the typed tenant-read owners. Revenue and quote intents are integrated with immutable original query custody and exact current subject rights. Historical read0009 passed47 bounded predicates. Current custody0018 records65 driver passes with zero activation deltas and actual deadline/input/finalizer-intake races, but failed mandatory independent verification. Partial checks reference canonical original query receipts through node-specific VerificationResults; only the full unchanged original condition can seal whole-Objective completion. HTTP output is a disposable projection of the complete durable query, not another durable envelope owner.
- Exact arithmetic and S4 finite policy machinery are inherited, not W1 novelty.
- The actual signed API/queue/restricted physical-worker/persistence/native-consumer path is integrated and passes native0013's unchanged independent oracle. Its terminal P7 RESOURCE reader slice retains historical identity without stale authority or renewed bounds. Physical recovery, mounted Work, cold reconstruction, final-cut scrutiny and the full campaign remain unqualified. No mock W2 adapter or competing lifecycle is introduced.
- This checkout's W1 driver is the sole shared-source writer under the explicit standalone decision. W2's separate checkout and unacknowledged joint seam remain unchanged. Audited mixed writers acquire the existing material fence before row/cursor locks; ordinary readers/transactions do not. The appended objective-budget migration avoids planning elevated closing-authority SQL for ordinary lease updates without changing its policy. Existing triggers and concurrent intake preparations remain enabled; no timeout was widened. These repairs are not an exhaustive inherited-concurrency qualification.

## Review conditions

No new scheduler, truth graph, resource/grant ledger, admission court or business grader. No duplicate registries. Parse external bytes with the existing schema library; use discriminated variants and exact rational decisions. Keep runtime/currentness boundaries even when a branded value was previously checked. Avoid scattered feature branches and thin pass-through modules.
