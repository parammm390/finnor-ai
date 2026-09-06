// Zod schemas for DomainPolicy / DomainAction — the config-over-code contract (§13, §29 blueprint).
// Business rule CONTENT never lives here; only its shape does.

import { z } from "zod";
import { OUTCOME_PACK_IDS, isRetiredWaterCanonicalEntity } from "@finnor/shared-types";

export const RoleSchema = z.enum(["owner"]);

export const DomainActionStatusSchema = z.enum([
  "draft",
  "pending",
  "approved",
  "rejected",
  "executing",
  "completed",
  "failed",
  "needs_human_review",
  "blocked_integration_unavailable",
]);

export const DomainPolicySchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  actionType: z.string().min(1),
  policy: z.record(z.unknown()),
  requiresConfirmation: z.boolean(),
  confirmationTemplate: z.string().nullable(),
  modelProvider: z.string().optional(),
  // §2.8: hours a gated action may sit "pending" before scan_approval_expiry
  // escalates it to needs_human_review — never auto-approved, never auto-rejected.
  // Unset means the application default (24h) applies.
  confirmationTimeoutHours: z.number().int().positive().nullable().optional(),
  // §3.1: what decision_receipts.policy_applied.version cites. Real rows start at 1
  // (migration 0023's column default) — never a fabricated per-row guess.
  version: z.number().int().nonnegative(),
});
export type DomainPolicyInput = z.infer<typeof DomainPolicySchema>;

export const DomainActionSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  actionType: z.string().min(1),
  payload: z.record(z.unknown()),
  policyId: z.string().uuid().nullable(),
  status: DomainActionStatusSchema,
  createdAt: z.string(),
});
export type DomainActionInput = z.infer<typeof DomainActionSchema>;

// ---- API boundary schemas (every route validates with these) ----

export const CanonicalEntityRefSchema = z.object({
  // Vertical packages own their entity strings. The authenticated resolver below
  // this schema checks the active registry; this seam only rejects the historical
  // Water extension before any lookup can occur.
  entityType: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/).refine((value) => !isRetiredWaterCanonicalEntity(value), "Entity type is retired"),
  entityId: z.string().uuid(),
}).strict();

const InteractionFilterValueSchema = z.union([
  z.string().max(200),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(200)).max(50),
]);

/** One bounded, versioned context contract for typed and voice intake. */
export const OperatingInteractionContextSchema = z.object({
  version: z.literal(1),
  capturedAt: z.string().datetime(),
  source: z.enum(["voice", "text", "console"]),
  activeWork: z.object({ workId: z.string().uuid() }).strict().optional(),
  focusedEntity: CanonicalEntityRefSchema.optional(),
  selectedEntities: z.array(CanonicalEntityRefSchema).max(50).default([]),
  excludedEntities: z.array(CanonicalEntityRefSchema).max(50).default([]),
  surface: z.object({
    id: z.enum(["home", "work", "agents", "deals"]),
    route: z.string().startsWith("/jarvis").max(300).optional(),
    spatialState: z.enum(["canvas", "detail", "list", "map", "timeline"]).optional(),
  }).strict(),
  filters: z.array(z.object({
    field: z.string().regex(/^[a-z][a-zA-Z0-9_.-]{0,63}$/),
    operator: z.enum(["eq", "neq", "in", "not_in", "gte", "lte", "contains"]),
    value: InteractionFilterValueSchema,
  }).strict()).max(20).default([]),
  timeContext: z.object({
    start: z.string().datetime().optional(),
    end: z.string().datetime().optional(),
    timezone: z.string().min(1).max(100).optional(),
  }).strict().optional(),
}).strict().superRefine((context, issue) => {
  const selected = new Set(context.selectedEntities.map((ref) => `${ref.entityType}:${ref.entityId}`));
  const excluded = new Set<string>();
  for (const ref of context.excludedEntities) {
    const key = `${ref.entityType}:${ref.entityId}`;
    if (excluded.has(key)) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["excludedEntities"], message: "Duplicate exclusions are not allowed" });
    excluded.add(key);
    if (!selected.has(key)) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["excludedEntities"], message: "An exclusion must belong to the direct selection" });
  }
  if (context.timeContext?.start && context.timeContext.end && context.timeContext.start > context.timeContext.end) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["timeContext"], message: "timeContext.start must be before timeContext.end" });
  }
});
export type OperatingInteractionContextInput = z.infer<typeof OperatingInteractionContextSchema>;

export const SubmitInstructionSchema = z.object({
  instruction: z.string().min(1).max(10_000),
  channel: z.enum(["voice", "text", "console"]).default("console"),
  sessionId: z.string().optional(),
  // A4.T6: opt-in only — deriving a key from instruction text by default would risk
  // silently collapsing two genuinely different instructions that happen to share the
  // same wording in a short window. A client that knows it might retry (network
  // timeout, etc.) supplies its own key; one that doesn't gets today's unchanged
  // behavior (every submission plans for real).
  idempotencyKey: z.string().min(1).max(200).optional(),
  // jarvis-v3 P3.T4: client-minted (kernel/instruction.ts), sent so a concurrent
  // GET /api/instructions/:id/events poll can trace this exact call's real phases
  // while it's still in flight — additive, optional, response shape unchanged.
  instructionId: z.string().uuid().optional(),
  // Phase 6: canonical Postgres conversation identity. The API resolves ownership;
  // sessionId remains transport provenance and can never select a thread.
  threadId: z.string().uuid().optional(),
  // Upgrade 2: an explicit continuation appends a new input to this active Work.
  // Omitting it creates a new Work (whose id equals instructionId when supplied).
  workId: z.string().uuid().optional(),
  activeContext: OperatingInteractionContextSchema.optional(),
});
export type SubmitInstruction = z.infer<typeof SubmitInstructionSchema>;

const ObjectiveAssertionSchema = z.object({
  path: z.array(z.union([z.string().min(1).max(120), z.number().int().nonnegative()])).max(24),
  operator: z.enum(["exists", "not_exists", "eq", "not_eq", "gte", "lte", "contains", "array_contains"]),
  expected: z.unknown().optional(),
}).strict();
const ObjectiveCriterionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no_open_execution") }).strict(),
  z.object({ kind: z.literal("all_objective_effects_verified"), minimumCount: z.number().int().min(0).max(25) }).strict(),
  z.object({ kind: z.literal("canonical_query"), request: z.record(z.unknown()), assertion: ObjectiveAssertionSchema }).strict(),
  z.object({ kind: z.literal("matched_wait"), minimumCount: z.number().int().min(1).max(25), eventType: z.string().min(1).max(200).optional() }).strict(),
  z.object({ kind: z.literal("delegation_state"), minimumCount: z.number().int().min(1).max(25), requiredStatus: z.enum(["acknowledged", "accepted", "completed"]) }).strict(),
  z.object({ kind: z.literal("computer_run_state"), minimumCount: z.number().int().min(1).max(25), requiredStatus: z.literal("succeeded"), evidenceRequired: z.boolean() }).strict(),
  z.object({ kind: z.literal("decision_evidence"), minimumCount: z.number().int().min(1).max(25), accepted: z.array(z.enum(["canonical_query", "business_effect", "matched_event", "delegation", "computer_run"])).min(1).max(5) }).strict(),
  z.object({ kind: z.literal("manual_verification"), reason: z.string().min(1).max(2_000) }).strict(),
]);
export const ObjectiveSuccessConditionInputSchema = z.object({
  version: z.literal(1),
  statement: z.string().min(1).max(10_000),
  mode: z.literal("all"),
  source: z.literal("explicit"),
  criteria: z.array(ObjectiveCriterionSchema).min(1).max(20),
}).strict();

export const StartObjectiveSchema = z.object({
  objective: z.string().min(1).max(10_000),
  channel: z.enum(["voice", "text", "console"]).default("text"),
  sessionId: z.string().max(500).optional(),
  instructionId: z.string().uuid().optional(),
  threadId: z.string().uuid().optional(),
  workId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  activeContext: OperatingInteractionContextSchema.optional(),
  successCondition: ObjectiveSuccessConditionInputSchema.optional(),
  budgets: z.object({
    maxSteps: z.number().int().min(1).max(50).optional(),
    maxActions: z.number().int().min(0).max(25).optional(),
    maxQueries: z.number().int().min(1).max(50).optional(),
    maxPlannerFailures: z.number().int().min(1).max(10).optional(),
    maxConsecutiveNoProgress: z.number().int().min(1).max(10).optional(),
    deadlineAt: z.string().datetime().optional(),
  }).optional(),
});

export const ControlObjectiveSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("continue") }),
  z.object({ command: z.literal("interrupt") }),
  z.object({ command: z.literal("cancel") }),
  z.object({ command: z.literal("redirect"), objective: z.string().min(1).max(10_000), channel: z.enum(["voice", "text", "console"]).default("text"), instructionId: z.string().uuid().optional(), idempotencyKey: z.string().min(1).max(200).optional(), successCondition: ObjectiveSuccessConditionInputSchema.optional() }),
]);

export const OutcomePackIdSchema = z.enum(OUTCOME_PACK_IDS);
export const OutcomePackModeSchema = z.enum(["shadow", "approval", "autopilot"]);
export const StartOutcomePackSchema = z.object({
  packId: OutcomePackIdSchema,
  input: z.record(z.unknown()),
  channel: z.enum(["voice", "text", "console"]).default("console"),
  sessionId: z.string().max(500).optional(),
  instructionId: z.string().uuid().optional(),
  workId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  activeContext: OperatingInteractionContextSchema.optional(),
  budgets: z.object({
    maxSteps: z.number().int().min(1).max(50).optional(),
    maxActions: z.number().int().min(0).max(25).optional(),
    maxQueries: z.number().int().min(1).max(50).optional(),
    maxPlannerFailures: z.number().int().min(1).max(10).optional(),
    maxConsecutiveNoProgress: z.number().int().min(1).max(10).optional(),
    deadlineAt: z.string().datetime().optional(),
  }).optional(),
}).strict();

const EffectClassSchema = z.enum(["internal_draft", "internal_write", "operational_change", "financial_write", "external_side_effect", "external_spend", "batch_external", "durable_workflow"]);
export const CreateAutonomyGrantSchema = z.object({
  packId: OutcomePackIdSchema,
  packVersion: z.number().int().positive(),
  scope: z.object({
    effectClasses: z.array(EffectClassSchema).min(1).max(8),
    resources: z.array(z.object({ type: z.string().min(1).max(120), ids: z.array(z.string().min(1).max(500)).max(100).optional() }).strict()).min(1).max(100),
    principal: z.string().min(1).max(200),
    providers: z.array(z.object({ provider: z.string().min(1).max(120), applicationAccountId: z.string().uuid().optional() }).strict()).max(50),
    maxAmountUsd: z.number().nonnegative().nullable(),
    maxRisk: z.enum(["low", "medium", "high"]),
    validFrom: z.string().datetime(),
    expiresAt: z.string().datetime(),
    policyVersion: z.number().int().positive().nullable(),
    authorityRevision: z.number().int().positive(),
    certificationFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    reviewAfter: z.string().datetime(),
  }).strict(),
  reason: z.string().trim().min(1).max(2_000),
}).strict();

export const RevokeAutonomyGrantSchema = z.object({ reason: z.string().trim().min(1).max(2_000) }).strict();
export const SetOutcomePackEnabledSchema = z.object({ packId: OutcomePackIdSchema, enabled: z.boolean(), reason: z.string().trim().min(1).max(2_000) }).strict();

export const HandoffWorkSchema = z.object({
  targetEmployeeId: z.string().uuid(),
  note: z.string().trim().min(1).max(2_000).optional(),
});

export const ConfirmActionSchema = z.object({
  note: z.string().max(2000).optional(),
  // TYPED_REQUIRED actions must carry an explicit confirmation signal. The
  // orchestrator records this in immutable action-log input and refuses a normal
  // approval with this field absent.
  typedConfirmation: z.literal(true).optional(),
});

export const RejectActionSchema = z.object({
  reason: z.string().max(2000).optional(),
});

export const EscalateActionSchema = z.object({
  note: z.string().max(2000).optional(),
});

export const UpsertPolicySchema = z.object({
  policy: z.record(z.unknown()),
  requiresConfirmation: z.boolean(),
  confirmationTemplate: z.string().nullable().optional(),
  modelProvider: z.string().optional(),
  confirmationTimeoutHours: z.number().int().positive().nullable().optional(),
  // Server-side upsert logic bumps this on a real config change (see
  // scripts/seed-tenant-policies.ts) — a caller may omit it and let the server decide.
  version: z.number().int().positive().optional(),
  // A future effective date stages a revision; past dates are rejected by the route.
  effectiveFrom: z.string().datetime().optional(),
});

export const AuditQuerySchema = z.object({
  actionType: z.string().optional(),
  status: DomainActionStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// Vapi webhook: transcript events feed the Planner as instructions.
// `call` uses .passthrough() at every level — Vapi's payload carries fields (customer.number,
// phoneNumberId, metadata, ...) this schema doesn't enumerate, and zod's default object behavior
// STRIPS unknown keys on parse. Previously call was `z.object({ id }).partial()` with no
// passthrough, which silently deleted call.customer.number and call.phoneNumberId on every
// webhook — caller-identity resolution and tenant-by-phone-number routing both depend on fields
// that never survived parsing.
export const VapiWebhookSchema = z.object({
  message: z
    .object({
      type: z.string(),
      call: z
        .object({
          id: z.string().optional(),
          phoneNumberId: z.string().optional(),
          customer: z.object({ number: z.string().optional() }).passthrough().optional(),
          phoneNumber: z.object({ number: z.string().optional() }).passthrough().optional(),
          metadata: z.record(z.unknown()).optional(),
        })
        .passthrough()
        .optional(),
      transcript: z.string().optional(),
      artifact: z.record(z.unknown()).optional(),
    })
    .passthrough(),
});
