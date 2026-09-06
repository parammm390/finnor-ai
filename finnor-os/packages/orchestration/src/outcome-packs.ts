import { createHash } from "node:crypto";
import { z } from "zod";
import {
  OUTCOME_PACK_IDS,
  isRetiredWaterCanonicalEntity,
  type CanonicalEntityRef,
  type ObjectiveSuccessCondition,
  type OutcomePackAutonomyMode,
  type OutcomePackDefinition,
  type OutcomePackId,
  type OutcomePackStartBinding,
  type TenantContext,
} from "@finnor/shared-types";
import { attachWorkEntity } from "@finnor/db";
import { parseObjectiveSuccessCondition } from "./objective-success";
import {
  startWorkObjective,
  type StartObjectiveOptions,
  type StartObjectiveResult,
} from "./objective-loop";

const dependencyVersions = {
  effectCompiler: 1,
  objectiveController: 1,
  autonomySemantics: 1,
  sourceTruth: 1,
  verification: 1,
} as const;

const invariantSlos: OutcomePackDefinition["slos"] = [
  { metric: "cross_tenant_effects", comparison: "eq", threshold: 0, unit: "count", critical: true, rationale: "Tenant isolation is an invariant." },
  { metric: "unapproved_effects_outside_grant", comparison: "eq", threshold: 0, unit: "count", critical: true, rationale: "Every consequential effect cites current authority." },
  { metric: "duplicate_consequential_effects", comparison: "eq", threshold: 0, unit: "count", critical: true, rationale: "Durable effect identity prevents duplicates." },
  { metric: "false_verified_success", comparison: "eq", threshold: 0, unit: "count", critical: true, rationale: "Provider acknowledgement is never canonical verification." },
  { metric: "secret_exposure", comparison: "eq", threshold: 0, unit: "count", critical: true, rationale: "Credentials remain inside the governed security boundary." },
  { metric: "verification_coverage", comparison: "gte", threshold: 1, unit: "ratio", critical: true, rationale: "Every certified terminal result is verified." },
  { metric: "event_to_resume_latency", comparison: "lte", threshold: 60_000, unit: "milliseconds", critical: false, rationale: "Matched evidence wakes durable Work promptly." },
];

function definition(
  id: OutcomePackId,
  title: string,
  objectiveClass: string,
  prerequisites: string[],
  capabilities: OutcomePackDefinition["requiredCapabilities"],
  evidence: string[],
  blocked: string[],
  verification: string[],
): OutcomePackDefinition {
  return {
    contractVersion: 1,
    id,
    version: 1,
    title,
    objectiveClass,
    supportedTenantPrerequisites: prerequisites,
    requiredCapabilities: capabilities,
    allowedEffectClasses: ["internal_draft", "internal_write", "operational_change", "external_side_effect", "durable_workflow"],
    permanentlyApprovalRequiredEffectClasses: ["operational_change", "financial_write", "external_side_effect", "external_spend", "batch_external", "durable_workflow"],
    authorityRequirements: ["the exact deal remains in scope", "current policy and authority revisions remain valid"],
    approvalBoundaries: ["all consequential external communication", "all closing, waiver, assignment, and deal-state changes"],
    recoveryPaths: ["re-inspect canonical deal truth", "wait for exact evidence", "replan", "reconcile", "escalate"],
    compensationCapabilities: ["only compensation explicitly named by the frozen BusinessEffect"],
    irreversibilityBoundaries: ["delivered communications and completed external effects remain historical truth"],
    evidenceRequirements: evidence,
    terminalBlockedConditions: blocked,
    verificationRules: verification,
    slos: invariantSlos,
    dependencyVersions,
  };
}

const SOURCE = { capability: "private_equity_source", required: true, maxSourceLagMs: 300_000, acceptedModes: ["real", "sandbox"] as Array<"real" | "sandbox"> };

export const OUTCOME_PACK_DEFINITIONS: Record<OutcomePackId, OutcomePackDefinition> = {
  deal_to_verified_closing_readiness: definition(
    "deal_to_verified_closing_readiness",
    "Deal to verified closing readiness",
    "private_equity_closing_readiness",
    ["one exact active deal", "current diligence and closing truth"],
    [SOURCE],
    ["verified closing-condition propositions", "resolved critical dependencies", "current closing-readiness query"],
    ["ambiguous deal", "unverified closing item", "contradicted proposition", "open critical dependency"],
    ["closing_readiness.eligible is true", "UNKNOWN, STALE, CONFLICTING, UNCERTAIN, or CONTRADICTED truth cannot pass"],
  ),
  deal_request_resolution: definition(
    "deal_request_resolution",
    "Open deal requests to verified resolution",
    "private_equity_request_resolution",
    ["one exact active deal", "current request and evidence truth"],
    [
      SOURCE,
      { capability: "communications", required: false, maxSourceLagMs: 300_000, acceptedModes: ["real", "sandbox"] },
    ],
    ["request lifecycle evidence", "matched inbound evidence when waiting", "zero open scoped requests"],
    ["ambiguous requested party", "stale source", "unmatched or conflicting evidence"],
    ["open_requests returns no rows for the certified scope", "a sent message alone is not request fulfillment"],
  ),
  critical_deal_dependency_resolution: definition(
    "critical_deal_dependency_resolution",
    "Critical deal dependency to verified resolution",
    "private_equity_dependency_resolution",
    ["one exact active deal", "current dependency graph"],
    [SOURCE],
    ["dependency graph", "linked Work and owner evidence", "zero unresolved critical dependencies"],
    ["dependency cycle", "unknown blocker state", "missing authority", "unverified resolution"],
    ["critical_dependencies returns no unresolved rows", "dependency resolution is re-read from canonical truth"],
  ),
  general_operator_objective: definition(
    "general_operator_objective",
    "Bounded operator objective to verified resolution",
    "bounded_operator_resolution",
    ["explicit bounded objective", "unambiguous active subject", "explicit success condition"],
    [],
    ["persisted explicit success condition", "current canonical evidence", "verified effects"],
    ["scope expansion", "material ambiguity", "unsupported capability", "stale truth", "human stop"],
    ["the persisted condition passes without weakening", "model-authored claims never substitute for canonical evidence"],
  ),
};

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).filter((key) => row[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}

export function outcomePackFingerprint(pack: OutcomePackDefinition | OutcomePackId): string {
  const value = typeof pack === "string" ? OUTCOME_PACK_DEFINITIONS[pack] : pack;
  return createHash("sha256").update(canonical(value)).digest("hex");
}

const RefSchema = z.object({
  entityType: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/)
    .refine((value) => !isRetiredWaterCanonicalEntity(value), "entity type is retired"),
  entityId: z.string().uuid(),
}).strict();
const Base = z.object({
  mode: z.enum(["shadow", "approval", "autopilot"]).default("approval"),
  objective: z.string().trim().min(1).max(10_000).optional(),
});
const Deal = Base.extend({ dealId: z.string().uuid() });
const StartSchemas = {
  deal_to_verified_closing_readiness: Deal,
  deal_request_resolution: Deal,
  critical_deal_dependency_resolution: Deal,
  general_operator_objective: Base.extend({
    objective: z.string().trim().min(1).max(10_000),
    subjectRefs: z.array(RefSchema).min(1).max(20),
    successCondition: z.unknown(),
  }),
} satisfies Record<OutcomePackId, z.ZodTypeAny>;

function dealCondition(
  statement: string,
  dealId: string,
  intent: "closing_readiness" | "open_requests" | "critical_dependencies",
): ObjectiveSuccessCondition {
  const assertion = intent === "closing_readiness"
    ? { path: ["eligible"], operator: "eq" as const, expected: true }
    : { path: ["rows", 0], operator: "not_exists" as const };
  return {
    version: 1,
    statement,
    mode: "all",
    source: "explicit",
    criteria: [
      { kind: "no_open_execution" },
      { kind: "canonical_query", request: { intent, dealId }, assertion },
      { kind: "decision_evidence", minimumCount: 1, accepted: ["canonical_query", "business_effect", "matched_event", "delegation", "computer_run"] },
    ],
  };
}

export function bindOutcomePack(packId: OutcomePackId, rawInput: unknown): OutcomePackStartBinding {
  const input = StartSchemas[packId].parse(rawInput) as Record<string, unknown> & {
    mode: OutcomePackAutonomyMode;
    objective?: string;
  };
  const pack = OUTCOME_PACK_DEFINITIONS[packId];
  let objective: string;
  let subjectRefs: CanonicalEntityRef<string>[];
  let successCondition: ObjectiveSuccessCondition;
  if (packId === "general_operator_objective") {
    objective = String(input.objective);
    subjectRefs = input.subjectRefs as CanonicalEntityRef<string>[];
    successCondition = parseObjectiveSuccessCondition(input.successCondition);
  } else {
    const dealId = String(input.dealId);
    subjectRefs = [{ entityType: "pe_deal", entityId: dealId }];
    objective = input.objective ?? `${pack.title} for deal ${dealId}.`;
    const intent = packId === "deal_to_verified_closing_readiness"
      ? "closing_readiness"
      : packId === "deal_request_resolution"
        ? "open_requests"
        : "critical_dependencies";
    successCondition = dealCondition(objective, dealId, intent);
  }
  return {
    packId,
    packVersion: pack.version,
    mode: input.mode,
    objective,
    subjectRefs,
    successCondition,
    input,
    certificationFingerprint: outcomePackFingerprint(pack),
  };
}

export async function startOutcomePack(
  packId: OutcomePackId,
  input: unknown,
  ctx: TenantContext,
  options: Omit<StartObjectiveOptions, "successCondition" | "outcomePack"> = {},
): Promise<StartObjectiveResult & { pack: OutcomePackStartBinding }> {
  if (!(OUTCOME_PACK_IDS as readonly string[]).includes(packId)) {
    throw new Error(`Unknown outcome pack: ${packId}`);
  }
  const pack = bindOutcomePack(packId, input);
  const started = await startWorkObjective(pack.objective, ctx, {
    ...options,
    successCondition: pack.successCondition,
    outcomePack: pack,
  });
  for (const ref of pack.subjectRefs) {
    await attachWorkEntity(ctx.tenantId, started.workId, {
      ...ref,
      relationship: "target",
      source: `outcome_pack:${pack.packId}:v${pack.packVersion}`,
    });
  }
  return { ...started, pack };
}
