export const SCOPE1_GATE_IDS = [
  "architecture",
  "deterministic-kernel",
  "persistence-races",
  "migration-security",
  "core-regressions",
  "phase15a",
  "performance",
] as const;

export type Scope1GateId = (typeof SCOPE1_GATE_IDS)[number];

export interface Scope1MandatoryCase {
  ordinal: number;
  id: string;
  statement: string;
  gates: readonly Scope1GateId[];
}

/** Exact named acceptance ledger required by the Scope-1 brief. A case can pass
 * only through executable gates; no placeholder or configuration-only success is
 * representable in this registry. */
export const SCOPE1_MANDATORY_CASES: readonly Scope1MandatoryCase[] = [
  { ordinal: 1, id: "scope1.deterministic-plan-semantics", statement: "Identical planning inputs produce identical accepted-plan semantics.", gates: ["deterministic-kernel", "core-regressions"] },
  { ordinal: 2, id: "scope1.concurrent-independent-branches", statement: "Independent DAG branches are concurrently executable within the configured frontier bound.", gates: ["deterministic-kernel", "persistence-races"] },
  { ordinal: 3, id: "scope1.dependency-gating", statement: "A dependent node cannot execute before every causal prerequisite is verified.", gates: ["deterministic-kernel"] },
  { ordinal: 4, id: "scope1.hundred-ready-nodes", statement: "One hundred independent ready nodes progress coherently in bounded batches.", gates: ["deterministic-kernel", "persistence-races", "performance"] },
  { ordinal: 5, id: "scope1.hundred-claim-contenders", statement: "One hundred contenders for the same node produce one physical claim winner.", gates: ["persistence-races", "performance"] },
  { ordinal: 6, id: "scope1.duplicate-delivery", statement: "Duplicate delivery cannot create a duplicate logical attempt.", gates: ["deterministic-kernel", "persistence-races"] },
  { ordinal: 7, id: "scope1.explicit-retry-attribution", statement: "An explicit retry creates a distinct attributable logical attempt with a recovery parent.", gates: ["deterministic-kernel", "migration-security"] },
  { ordinal: 8, id: "scope1.plan-supersession-fence", statement: "PlanRevision supersession fences stale logical and physical claims.", gates: ["persistence-races", "migration-security"] },
  { ordinal: 9, id: "scope1.stale-objective-fence", statement: "A stale Objective generation cannot advance Work.", gates: ["architecture", "persistence-races", "core-regressions"] },
  { ordinal: 10, id: "scope1.stale-authority-fence", statement: "Stale Authority cannot cross a consequential effect boundary.", gates: ["architecture", "core-regressions"] },
  { ordinal: 11, id: "scope1.cancel-claim-race", statement: "Cancellation racing a claim leaves no executable stale owner.", gates: ["persistence-races", "core-regressions"] },
  { ordinal: 12, id: "scope1.cancel-effect-race", statement: "Cancellation racing authorization or effect execution preserves ambiguity and requires reconciliation.", gates: ["deterministic-kernel", "persistence-races", "core-regressions"] },
  { ordinal: 13, id: "scope1.concurrent-budget", statement: "Concurrent branches cannot exceed shared concurrency, attempt, action, query, wait, or cost budgets.", gates: ["deterministic-kernel", "persistence-races"] },
  { ordinal: 14, id: "scope1.deadline-recovery", statement: "Deadline exhaustion produces an append-only durable RecoveryDecision.", gates: ["deterministic-kernel", "persistence-races"] },
  { ordinal: 15, id: "scope1.wait-restart", statement: "A generation-pinned durable wait survives process restart.", gates: ["architecture", "core-regressions"] },
  { ordinal: 16, id: "scope1.duplicate-wake", statement: "A duplicate wake produces one logical advancement.", gates: ["architecture", "core-regressions"] },
  { ordinal: 17, id: "scope1.stale-wake-fence", statement: "A stale-revision wake cannot revive obsolete work.", gates: ["architecture", "core-regressions"] },
  { ordinal: 18, id: "scope1.pre-invocation-crash", statement: "A crash proven to occur before provider invocation is safely recoverable.", gates: ["persistence-races", "core-regressions"] },
  { ordinal: 19, id: "scope1.ambiguous-provider-crash", statement: "An ambiguous post-invocation provider crash enters reconciliation and forbids blind retry.", gates: ["deterministic-kernel", "persistence-races", "core-regressions"] },
  { ordinal: 20, id: "scope1.provider-versus-reality", statement: "Provider response and acknowledgement remain distinct from verified external reality.", gates: ["deterministic-kernel", "architecture", "core-regressions"] },
  { ordinal: 21, id: "scope1.irreversible-effect-no-replay", statement: "A verified irreversible BusinessEffect cannot replay.", gates: ["deterministic-kernel", "core-regressions"] },
  { ordinal: 22, id: "scope1.replan-preserves-effects", statement: "Replanning preserves verified historical effects and their attribution.", gates: ["architecture", "persistence-races", "core-regressions"] },
  { ordinal: 23, id: "scope1.revision-diff-history", statement: "Deterministic PlanRevision diff and ancestry history are retained.", gates: ["persistence-races", "migration-security"] },
  { ordinal: 24, id: "scope1.readonly-causal-replay", statement: "Causal replay produces zero external effects while exposing exact orchestration ancestry.", gates: ["architecture", "persistence-races"] },
  { ordinal: 25, id: "scope1.recovery-redeploy", statement: "Recovery decisions converge and survive process restart or redeploy.", gates: ["persistence-races", "migration-security"] },
  { ordinal: 26, id: "scope1.multiple-workers", statement: "Multiple workers operate safely through exact leases and database fencing.", gates: ["persistence-races", "core-regressions"] },
  { ordinal: 27, id: "scope1.tenant-isolation", statement: "Tenant isolation remains database-enforced and fail-closed.", gates: ["persistence-races", "migration-security", "core-regressions"] },
  { ordinal: 28, id: "scope1.planner-compiler-regression", statement: "Existing deterministic planner and compiler semantics remain green.", gates: ["core-regressions"] },
  { ordinal: 29, id: "scope1.domain-action-regression", statement: "Existing DomainAction identity and execution semantics remain green.", gates: ["core-regressions"] },
  { ordinal: 30, id: "scope1.business-effect-regression", statement: "Existing BusinessEffect intent and external-truth semantics remain green.", gates: ["core-regressions"] },
  { ordinal: 31, id: "scope1.authority-approval-regression", statement: "Existing Authority and approval semantics remain green.", gates: ["core-regressions"] },
  { ordinal: 32, id: "scope1.receipt-verification-regression", statement: "Existing DecisionReceipt and verification semantics remain green.", gates: ["core-regressions"] },
  { ordinal: 33, id: "scope1.completion-proof-regression", statement: "Existing CompletionProof semantics remain green.", gates: ["core-regressions"] },
  { ordinal: 34, id: "scope1.workforce-is-adapter", statement: "Workforce integration remains an execution adapter and does not become a second scheduler or Authority system.", gates: ["architecture", "persistence-races", "core-regressions"] },
  { ordinal: 35, id: "scope1.phase15a-safety", statement: "Phase 15A production governance and release safety remain green.", gates: ["phase15a"] },
] as const;

export const SCOPE1_MANDATORY_CASE_COUNT = SCOPE1_MANDATORY_CASES.length;
