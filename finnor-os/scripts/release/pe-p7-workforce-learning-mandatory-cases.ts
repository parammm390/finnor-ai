export const P7_REQUIRED_GROUPS = [
  "baseline",
  "workforce-identity-revisions",
  "capability-eligibility",
  "assignment-ranking",
  "claim-concurrency",
  "agent-execution",
  "p6-integration",
  "human-only-p5-boundaries",
  "reassignment-recovery",
  "learning-observations",
  "failure-attribution",
  "metrics",
  "learning-proposals",
  "promotion-versioning",
  "security-rls",
  "api-openapi",
  "frontend-truth",
  "attention-integration",
  "migrations",
  "performance",
  "p1-p6-core-regressions",
] as const;

export type P7MandatoryGroup = (typeof P7_REQUIRED_GROUPS)[number];

export const P7_GATE_IDS = [
  "architecture",
  "typecheck-contracts",
  "workforce-unit",
  "runtime-concurrency",
  "migrations",
  "performance",
  "regressions",
] as const;

export type P7GateId = (typeof P7_GATE_IDS)[number];

export interface P7MandatoryCase {
  id: string;
  group: P7MandatoryGroup;
  statement: string;
  gates: readonly P7GateId[];
}

/** One auditable acceptance case per group required by the Phase 7 brief. The
 * registry is deliberately not inflated with synthetic permutations; each case
 * is backed by one or more executable gates below. */
export const P7_MANDATORY_CASES: readonly P7MandatoryCase[] = [
  { id: "p7.baseline", group: "baseline", statement: "The verified P6 substrate and declared migration lineage remain intact.", gates: ["architecture", "migrations", "regressions"] },
  { id: "p7.identity-revisions", group: "workforce-identity-revisions", statement: "AI profiles are non-human identities and every historical execution pins an immutable configuration revision.", gates: ["architecture", "workforce-unit", "runtime-concurrency", "migrations"] },
  { id: "p7.capability-eligibility", group: "capability-eligibility", statement: "Exact existing P6/Core grants are hard-filtered and never create Authority.", gates: ["workforce-unit", "runtime-concurrency"] },
  { id: "p7.assignment-ranking", group: "assignment-ranking", statement: "Only eligible workers enter deterministic lexicographic ranking and small samples stay UNKNOWN.", gates: ["workforce-unit", "performance"] },
  { id: "p7.claim-concurrency", group: "claim-concurrency", statement: "Database claims and leases yield one coherent assignment owner under races and replay.", gates: ["runtime-concurrency", "performance"] },
  { id: "p7.agent-execution", group: "agent-execution", statement: "The single workforce job resumes the exact P6 ObjectiveLoop and never invokes arbitrary plugins directly.", gates: ["architecture", "runtime-concurrency"] },
  { id: "p7.p6-integration", group: "p6-integration", statement: "P6 remains the plan-validity and canonical execution owner while P7 supplies governed ownership only.", gates: ["architecture", "runtime-concurrency", "regressions"] },
  { id: "p7.human-only", group: "human-only-p5-boundaries", statement: "AI assignment cannot unlock approval, vote, attestation, verification, signatory, or other human-only P5 boundaries.", gates: ["workforce-unit", "runtime-concurrency", "regressions"] },
  { id: "p7.reassignment", group: "reassignment-recovery", statement: "Lease, revision, route, budget, repeated-failure, and operator reassignment preserve immutable ownership history.", gates: ["runtime-concurrency"] },
  { id: "p7.observations", group: "learning-observations", statement: "Immutable observations require exact tenant-scoped P6/execution provenance and verified outcomes.", gates: ["workforce-unit", "runtime-concurrency", "migrations"] },
  { id: "p7.failure-attribution", group: "failure-attribution", statement: "Worker, compile, authority, human, provider, external, stale, business, timeout, cancellation, recovery, and unknown outcomes stay distinct.", gates: ["workforce-unit", "runtime-concurrency"] },
  { id: "p7.metrics", group: "metrics", statement: "Bounded deterministic metrics preserve revision/context attribution and exclude non-worker failures from worker quality.", gates: ["workforce-unit", "performance"] },
  { id: "p7.proposals", group: "learning-proposals", statement: "The existing learning_digest creates only typed, evidence-pinned, idempotent soft proposals and fails closed on partial evidence.", gates: ["architecture", "workforce-unit", "runtime-concurrency", "performance"] },
  { id: "p7.promotion", group: "promotion-versioning", statement: "Authorized human promotion races create immutable LearningRevision and AgentProfileRevision lineage.", gates: ["runtime-concurrency", "migrations"] },
  { id: "p7.security", group: "security-rls", statement: "AI/human separation, tenant isolation, immutable history, hard-policy protection, and least privilege are database and code invariants.", gates: ["architecture", "workforce-unit", "runtime-concurrency", "migrations"] },
  { id: "p7.api-openapi", group: "api-openapi", statement: "Configuration, reassignment, review/promotion, and workforce_status routes match generated OpenAPI contracts.", gates: ["architecture", "typecheck-contracts", "workforce-unit"] },
  { id: "p7.frontend", group: "frontend-truth", statement: "JARVIS reads server-owned workforce truth, shows explicit source states, and contains no static fleet authority.", gates: ["architecture", "typecheck-contracts"] },
  { id: "p7.attention", group: "attention-integration", statement: "Workforce exceptions use the existing P6 attention_queue and deterministic ranking.", gates: ["architecture", "workforce-unit"] },
  { id: "p7.migrations", group: "migrations", statement: "Fresh lineage and populated P1-P6 upgrade reach 0129 with RLS, guards, no fake backfill, and preserved fingerprints.", gates: ["migrations"] },
  { id: "p7.performance", group: "performance", statement: "Eligibility, ranking, atomic claim, workforce_status, aggregation, and proposal generation meet measured bounds.", gates: ["performance"] },
  { id: "p7.regressions", group: "p1-p6-core-regressions", statement: "Focused P1 through P6 and Core truth/execution regressions remain green.", gates: ["regressions"] },
] as const;

export const P7_MANDATORY_CASE_COUNT = P7_MANDATORY_CASES.length;
