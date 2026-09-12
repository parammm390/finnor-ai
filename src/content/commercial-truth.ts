export const DEPLOYMENT_START_USD = 30_000

export const productCategory = "Private Equity decision + execution infrastructure"

export const productPillars = [
  {
    name: "Canonical deal truth",
    verb: "Keep the deal world coherent",
    copy: "Strategies, opportunities, deals, investment cases, findings, risks, requests, deliverables, milestones, closing conditions, and documents remain exact objects with source-backed relationships.",
  },
  {
    name: "Underwriting lineage",
    verb: "Inspect every material model path",
    copy: "Models, immutable versions, scenarios, runs, sensitivities, assumptions, and outputs stay connected so an investment conclusion can be traced to its inputs.",
  },
  {
    name: "IC governance",
    verb: "Preserve the decision record",
    copy: "Questions, recommendations, votes, dissent, conditions, proposals, and final Decisions remain distinct, inspectable records rather than flattened meeting notes.",
  },
  {
    name: "Work + planning",
    verb: "Turn gaps into bounded execution",
    copy: "Diligence and closing work carry goals, plan revisions, dependencies, owners, definitions of done, and recovery paths linked to the exact PE context.",
  },
  {
    name: "Governed execution",
    verb: "Keep authority at the boundary",
    copy: "Candidate actions remain proposals until the existing policy and Authority system evaluates the exact operation, resource, and revision.",
  },
  {
    name: "Evidence + receipts",
    verb: "Verify change without storytelling",
    copy: "Evidence versions, source observations, conflicts, DecisionReceipts, and CompletionProofs show what is known, unknown, stale, conflicting, attempted, and verified.",
  },
  {
    name: "Governed AI workforce",
    verb: "Assign bounded work, not authority",
    copy: "Agent profiles, immutable revisions, capability grants, assignments, outcomes, and reviewed learning remain governed by the same Work and proof contracts.",
  },
] as const

// The legacy export name is retained only for existing presentation imports. Its
// values are the canonical P8 PE product pillars; no legacy semantic config remains.
export const operatingAreas = productPillars.map((pillar, index) => ({
  ...pillar,
  accent: ["electric", "blue", "violet", "orange"][index % 4],
}))

export const faqItems = [
  {
    question: "What is FINNOR?",
    answer: "FINNOR is Private Equity decision + execution infrastructure. It connects canonical deal truth, underwriting lineage, IC governance, Work and planning, governed execution, evidence and receipts, and a governed AI workforce without creating a second source of truth.",
  },
  {
    question: "What is JARVIS?",
    answer: "JARVIS is FINNOR’s owner operating surface. Home holds the current command context and attention; Deals centers the Company Brain; Work exposes plans, actions, effects, receipts, proof, and recovery; Agents exposes the governed workforce and learning record.",
  },
  {
    question: "Does FINNOR make investment decisions autonomously?",
    answer: "No. FINNOR can assemble evidence, expose lineage, prepare bounded work, and surface candidate actions. Investment judgment and consequential authority remain with the people and governance process configured for the firm.",
  },
  {
    question: "Does FINNOR replace source systems?",
    answer: "Not by implication. FINNOR composes existing canonical records and source-backed relationships. The deployment defines which sources are authoritative, how freshness and conflicts are represented, and which operations can cross an execution boundary.",
  },
  {
    question: "What does the Company Brain contain?",
    answer: "It is a deterministic read projection over existing PE, evidence, document, underwriting, IC, Work, planning, execution, receipt, proof, attention, and workforce truth. It does not introduce a parallel graph database or infer relationships that are not persisted.",
  },
  {
    question: "How is uncertainty represented?",
    answer: "Facts carry source references, timestamps, derivation where applicable, and an epistemic state: KNOWN, UNKNOWN, STALE, or CONFLICTING. Missing causality stays empty rather than being guessed from chronology.",
  },
  {
    question: "How do agents operate?",
    answer: "Agents receive explicit profiles, immutable revisions, bounded capability grants, budgets, and assignments linked to Work. A grant permits an attempt; it does not bypass Policy, Authority, BusinessEffect, receipts, proof, or human review.",
  },
  {
    question: "How is tenant isolation preserved?",
    answer: "Tenant identity comes from the authenticated session, never a client-supplied tenant ID. Object reads, search, traversal, provenance, history, inspection, and linked Work remain inside that boundary and fail closed.",
  },
  {
    question: "What does a production deployment include?",
    answer: "Scope can include truth and source mapping, PE workflow configuration, authority boundaries, workspace configuration, integrations, recovery testing, onboarding, production activation, and ongoing operating support. Exact scope is agreed for the firm.",
  },
  {
    question: "How much does a deployment cost?",
    answer: "Production deployments start around $30,000. Final pricing depends on source quality, integration depth, underwriting and IC scope, Work and execution coverage, authority requirements, custom workspace needs, reliability, and ongoing support.",
  },
] as const
