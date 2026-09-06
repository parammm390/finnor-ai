import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  BusinessEffectSet,
  BusinessEffectVerification,
  ObjectiveCompletionEvidence,
  ObjectiveSuccessAssertion,
  ObjectiveSuccessCondition,
  ObjectiveSuccessCriterion,
  ObjectiveSuccessCriterionResult,
  ObjectiveSuccessVerification,
  OperationalQueryRequest,
  CanonicalOperationalQueryRequest,
} from "@finnor/shared-types";
import {
  businessEffects,
  businessOperations,
  computerArtifacts,
  computerRuns,
  delegations,
  domainActions,
  integrationEvents,
  withTenant,
  workEventWaits,
} from "@finnor/db";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { validateOperationalQueryRequest } from "./fast-read-lane";
import { executeTenantOperationalQuery } from "./operational-query-runtime";
import { evaluateDealCloseEligibility, loadDealExecutionGraph, type PeMutationContext } from "@finnor/private-equity";

const PathSchema = z.array(z.union([z.string().min(1).max(120), z.number().int().nonnegative()])).max(24);
const AssertionSchema = z.object({
  path: PathSchema,
  operator: z.enum(["exists", "not_exists", "eq", "not_eq", "gte", "lte", "contains", "array_contains"]),
  expected: z.unknown().optional(),
}).strict();
const QueryEvidenceSchema = z.object({ kind: z.literal("canonical_query"), request: z.record(z.unknown()), assertion: AssertionSchema }).strict();
const CompletionEvidenceSchema = z.discriminatedUnion("kind", [
  QueryEvidenceSchema,
  z.object({ kind: z.literal("business_effect"), businessEffectId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("matched_event"), integrationEventId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("delegation"), delegationId: z.string().uuid(), requiredStatus: z.enum(["acknowledged", "accepted", "completed"]) }).strict(),
  z.object({ kind: z.literal("computer_run"), computerRunId: z.string().uuid(), evidenceRequired: z.boolean().optional() }).strict(),
]);
const CriterionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no_open_execution") }).strict(),
  z.object({ kind: z.literal("all_objective_effects_verified"), minimumCount: z.number().int().min(0).max(25) }).strict(),
  QueryEvidenceSchema,
  z.object({
    kind: z.literal("private_equity_truth"),
    dealId: z.string().uuid(),
    entityType: z.enum(["pe_deal", "pe_request", "pe_finding", "pe_deal_risk", "pe_closing_condition", "pe_closing_item"]),
    entityId: z.string().uuid(),
    requirement: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("state_in"), states: z.array(z.string().min(1).max(80)).min(1).max(10) }).strict(),
      z.object({ kind: z.literal("close_eligible") }).strict(),
      z.object({ kind: z.literal("deal_closed") }).strict(),
    ]),
  }).strict(),
  z.object({ kind: z.literal("matched_wait"), minimumCount: z.number().int().min(1).max(25), eventType: z.string().min(1).max(200).optional() }).strict(),
  z.object({ kind: z.literal("delegation_state"), minimumCount: z.number().int().min(1).max(25), requiredStatus: z.enum(["acknowledged", "accepted", "completed"]) }).strict(),
  z.object({ kind: z.literal("computer_run_state"), minimumCount: z.number().int().min(1).max(25), requiredStatus: z.literal("succeeded"), evidenceRequired: z.boolean() }).strict(),
  z.object({ kind: z.literal("decision_evidence"), minimumCount: z.number().int().min(1).max(25), accepted: z.array(z.enum(["canonical_query", "business_effect", "matched_event", "delegation", "computer_run"])).min(1).max(5) }).strict(),
  z.object({ kind: z.literal("manual_verification"), reason: z.string().min(1).max(2_000) }).strict(),
]);
export const ObjectiveSuccessConditionSchema = z.object({
  version: z.literal(1),
  statement: z.string().min(1).max(10_000),
  mode: z.literal("all"),
  source: z.enum(["explicit", "objective_first_policy", "legacy_backfill"]),
  criteria: z.array(CriterionSchema).min(1).max(20),
}).strict();
export const ObjectiveCompletionEvidenceSchema = z.array(CompletionEvidenceSchema).max(20);

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).filter((key) => row[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function validateQueries(condition: ObjectiveSuccessCondition): ObjectiveSuccessCondition {
  for (const criterion of condition.criteria) {
    if (criterion.kind !== "canonical_query") continue;
    const parsed = validateOperationalQueryRequest(criterion.request);
    if (!parsed.success) throw new Error(`Invalid objective success query: ${parsed.error}`);
    criterion.request = parsed.request;
  }
  return condition;
}

export function parseObjectiveSuccessCondition(value: unknown): ObjectiveSuccessCondition {
  const parsed = ObjectiveSuccessConditionSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid objective success condition: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  return validateQueries(parsed.data as ObjectiveSuccessCondition);
}

export function parseObjectiveCompletionEvidence(value: unknown): ObjectiveCompletionEvidence[] {
  const parsed = ObjectiveCompletionEvidenceSchema.safeParse(value ?? []);
  if (!parsed.success) throw new Error(`Invalid objective completion evidence: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  const evidence = parsed.data as ObjectiveCompletionEvidence[];
  for (const item of evidence) {
    if (item.kind !== "canonical_query") continue;
    const request = validateOperationalQueryRequest(item.request);
    if (!request.success) throw new Error(`Invalid objective completion query evidence: ${request.error}`);
    item.request = request.request;
  }
  return evidence;
}

/** Conservative default: effects must verify, execution must be settled, and the
 * completion decision must cite current business evidence. Response/delegation/
 * computer objectives additionally require the corresponding durable outcome. */
export function defaultObjectiveSuccessCondition(objective: string): ObjectiveSuccessCondition {
  const criteria: ObjectiveSuccessCriterion[] = [
    { kind: "no_open_execution" },
    { kind: "all_objective_effects_verified", minimumCount: 0 },
  ];
  const requiresMatchedEvent = /(?:\b(?:when|until|once|after)\b.{0,100}\b(?:reply|response|responds?|confirmation from)\b|\b(?:vendor|supplier)\b.{0,100}\b(?:reply|responds?|confirms?)\b)/i.test(objective);
  if (requiresMatchedEvent) {
    criteria.push({ kind: "matched_wait", minimumCount: 1 });
  }
  const requiresDelegation = /\b(?:delegate|delegation|acknowledg|hand off|handoff)\b/i.test(objective);
  if (requiresDelegation) {
    criteria.push({ kind: "delegation_state", minimumCount: 1, requiredStatus: /\bcomplete|finish\b/i.test(objective) ? "completed" : "acknowledged" });
  }
  const requiresComputer = /\b(?:computer|browser)\b/i.test(objective);
  if (requiresComputer) criteria.push({ kind: "computer_run_state", minimumCount: 1, requiredStatus: "succeeded", evidenceRequired: true });
  const acceptsCommunicationEffect = /\b(?:send|message|email|text|call|contact|follow up|notify)\b/i.test(objective);
  const accepted: Array<ObjectiveCompletionEvidence["kind"]> = ["canonical_query"];
  if (acceptsCommunicationEffect) accepted.push("business_effect");
  if (requiresMatchedEvent) accepted.push("matched_event");
  if (requiresDelegation) accepted.push("delegation");
  if (requiresComputer) accepted.push("computer_run");
  criteria.push({
    kind: "decision_evidence",
    minimumCount: 1,
    accepted,
  });
  return { version: 1, statement: objective.trim(), mode: "all", source: "objective_first_policy", criteria };
}

/** Canonical PE completion contract. Mutation success alone never satisfies this:
 * the verifier re-reads the PE2 graph/eligibility and, for close, requires the
 * canonical close timestamp, close event, and finalized receipt. */
export function privateEquityObjectiveSuccessCondition(params: {
  objective: string;
  dealId: string;
  subject?: { entityType: "pe_request" | "pe_finding" | "pe_deal_risk" | "pe_closing_condition" | "pe_closing_item"; entityId: string };
}): ObjectiveSuccessCondition {
  const normalized = params.objective.toLocaleLowerCase();
  let criterion: ObjectiveSuccessCriterion | null = null;
  if (/\bready\s+to\s+close\b|\bclose[- ]ready\b/.test(normalized)) {
    criterion = { kind: "private_equity_truth", dealId: params.dealId, entityType: "pe_deal", entityId: params.dealId, requirement: { kind: "close_eligible" } };
  } else if (/\bclose(?:d|ing)?\b/.test(normalized) && !params.subject) {
    criterion = { kind: "private_equity_truth", dealId: params.dealId, entityType: "pe_deal", entityId: params.dealId, requirement: { kind: "deal_closed" } };
  } else if (params.subject?.entityType === "pe_request") {
    criterion = { kind: "private_equity_truth", dealId: params.dealId, ...params.subject, requirement: { kind: "state_in", states: ["fulfilled"] } };
  } else if (params.subject?.entityType === "pe_finding") {
    criterion = { kind: "private_equity_truth", dealId: params.dealId, ...params.subject, requirement: { kind: "state_in", states: /\baccept/.test(normalized) ? ["accepted"] : ["resolved"] } };
  } else if (params.subject?.entityType === "pe_deal_risk") {
    criterion = { kind: "private_equity_truth", dealId: params.dealId, ...params.subject, requirement: { kind: "state_in", states: /\baccept/.test(normalized) ? ["accepted"] : ["resolved"] } };
  } else if (params.subject?.entityType === "pe_closing_condition") {
    criterion = { kind: "private_equity_truth", dealId: params.dealId, ...params.subject, requirement: { kind: "state_in", states: /\bwaiv/.test(normalized) ? ["waived"] : ["satisfied", "waived"] } };
  } else if (params.subject?.entityType === "pe_closing_item") {
    criterion = { kind: "private_equity_truth", dealId: params.dealId, ...params.subject, requirement: { kind: "state_in", states: ["verified"] } };
  }
  if (!criterion) return defaultObjectiveSuccessCondition(params.objective);
  return {
    version: 1,
    statement: params.objective.trim(),
    mode: "all",
    source: "objective_first_policy",
    criteria: [
      { kind: "no_open_execution" },
      { kind: "all_objective_effects_verified", minimumCount: 0 },
      criterion,
      { kind: "decision_evidence", minimumCount: 1, accepted: ["canonical_query", "business_effect", "matched_event"] },
    ],
  };
}

type EffectInspection = {
  id: string;
  status: string;
  effect: BusinessEffectSet;
  verification: BusinessEffectVerification | null;
};

export interface ObjectiveSuccessInspection {
  actions: Array<{ id: string; status: string }>;
  operations: Array<{ id: string; status: string }>;
  businessEffects: EffectInspection[];
  delegations: Array<{ id: string; status: string; acknowledgedAt?: string | null; acceptedAt?: string | null; completedAt?: string | null }>;
  computerRuns: Array<{ id: string; status: string; evidence?: unknown[] }>;
  eventWaits: Array<{ id: string; status: string; expectedEventType: string; matchedEventId?: string | null }>;
  integrationEvents: Array<{ id: string; eventType: string; status: string; workId?: string | null }>;
}

/** Reload the narrow evidence surface at the completion boundary. The planner's
 * earlier inspection is useful context, but it is not authoritative for a terminal
 * transition because effects and external events may have changed while it reasoned. */
export async function inspectCurrentObjectiveSuccessState(
  tenantId: string,
  workId: string,
  objectiveLoopId: string,
): Promise<ObjectiveSuccessInspection> {
  return withTenant(tenantId, async (db) => {
    const actions = await db.select({ id: domainActions.id, status: domainActions.status })
      .from(domainActions)
      .where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.workId, workId)))
      .orderBy(asc(domainActions.createdAt));
    const actionIds = actions.map((row) => row.id);
    const effects = actionIds.length === 0 ? [] : await db.select({
      id: businessEffects.id,
      status: businessEffects.status,
      effect: businessEffects.effect,
      verification: businessEffects.verification,
    }).from(businessEffects).where(and(
      eq(businessEffects.tenantId, tenantId),
      inArray(businessEffects.domainActionId, actionIds),
    )).orderBy(asc(businessEffects.createdAt));
    const operations = await db.select({ id: businessOperations.id, status: businessOperations.status })
      .from(businessOperations)
      .where(and(eq(businessOperations.tenantId, tenantId), eq(businessOperations.workId, workId)))
      .orderBy(asc(businessOperations.createdAt));
    const delegationRows = await db.select({
      id: delegations.id,
      status: delegations.status,
      acknowledgedAt: delegations.acknowledgedAt,
      acceptedAt: delegations.acceptedAt,
      completedAt: delegations.completedAt,
    }).from(delegations).where(and(eq(delegations.tenantId, tenantId), eq(delegations.workId, workId))).orderBy(asc(delegations.createdAt));
    const runRows = await db.select({ id: computerRuns.id, status: computerRuns.status, result: computerRuns.result })
      .from(computerRuns)
      .where(and(eq(computerRuns.tenantId, tenantId), eq(computerRuns.workId, workId)))
      .orderBy(asc(computerRuns.createdAt));
    const runIds = runRows.map((row) => row.id);
    const artifacts = runIds.length === 0 ? [] : await db.select({ id: computerArtifacts.id, runId: computerArtifacts.runId })
      .from(computerArtifacts)
      .where(and(eq(computerArtifacts.tenantId, tenantId), inArray(computerArtifacts.runId, runIds)))
      .orderBy(asc(computerArtifacts.createdAt));
    const waits = await db.select({
      id: workEventWaits.id,
      status: workEventWaits.status,
      expectedEventType: workEventWaits.expectedEventType,
      matchedEventId: workEventWaits.matchedEventId,
    }).from(workEventWaits).where(and(
      eq(workEventWaits.tenantId, tenantId),
      eq(workEventWaits.objectiveLoopId, objectiveLoopId),
    )).orderBy(asc(workEventWaits.createdAt));
    const matchedEventIds = waits.flatMap((row) => row.matchedEventId ? [row.matchedEventId] : []);
    const eventScope = matchedEventIds.length > 0
      ? or(eq(integrationEvents.workId, workId), inArray(integrationEvents.id, matchedEventIds))!
      : eq(integrationEvents.workId, workId);
    const events = await db.select({
      id: integrationEvents.id,
      eventType: integrationEvents.eventType,
      status: integrationEvents.status,
      workId: integrationEvents.workId,
    }).from(integrationEvents).where(and(eq(integrationEvents.tenantId, tenantId), eventScope)).orderBy(asc(integrationEvents.receivedAt));
    return {
      actions,
      operations,
      businessEffects: effects.map((row) => ({
        ...row,
        effect: row.effect as BusinessEffectSet,
        verification: row.verification as BusinessEffectVerification | null,
      })),
      delegations: delegationRows.map((row) => ({
        id: row.id,
        status: row.status,
        acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
        acceptedAt: row.acceptedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
      })),
      computerRuns: runRows.map((run) => {
        const artifactEvidence = artifacts.filter((artifact) => artifact.runId === run.id);
        const result = run.result && typeof run.result === "object" && !Array.isArray(run.result) ? run.result as Record<string, unknown> : null;
        return {
          id: run.id,
          status: run.status,
          evidence: [
            ...artifactEvidence,
            ...(result?.verified === true ? [{ kind: "verified_computer_result", result }] : []),
          ],
        };
      }),
      eventWaits: waits,
      integrationEvents: events,
    };
  });
}

function atPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

function partialMatch(actual: unknown, expected: unknown): boolean {
  if (!expected || typeof expected !== "object") return canonical(actual) === canonical(expected);
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((item) => actual.some((candidate) => partialMatch(candidate, item)));
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  return Object.entries(expected as Record<string, unknown>).every(([key, value]) => partialMatch((actual as Record<string, unknown>)[key], value));
}

export function evaluateObjectiveAssertion(value: unknown, assertion: ObjectiveSuccessAssertion): { satisfied: boolean; actual: unknown } {
  const actual = atPath(value, assertion.path);
  let satisfied = false;
  switch (assertion.operator) {
    case "exists": satisfied = actual !== undefined && actual !== null; break;
    case "not_exists": satisfied = actual === undefined || actual === null; break;
    case "eq": satisfied = canonical(actual) === canonical(assertion.expected); break;
    case "not_eq": satisfied = canonical(actual) !== canonical(assertion.expected); break;
    case "gte": satisfied = typeof actual === "number" && typeof assertion.expected === "number" && actual >= assertion.expected; break;
    case "lte": satisfied = typeof actual === "number" && typeof assertion.expected === "number" && actual <= assertion.expected; break;
    case "contains": satisfied = typeof actual === "string" && typeof assertion.expected === "string" && actual.includes(assertion.expected); break;
    case "array_contains": satisfied = Array.isArray(actual) && actual.some((item) => partialMatch(item, assertion.expected)); break;
  }
  return { satisfied, actual };
}

function delegationReached(row: ObjectiveSuccessInspection["delegations"][number], required: "acknowledged" | "accepted" | "completed"): boolean {
  if (required === "completed") return row.status === "completed" || Boolean(row.completedAt);
  if (required === "accepted") return ["accepted", "completed"].includes(row.status) || Boolean(row.acceptedAt || row.completedAt);
  return ["acknowledged", "accepted", "completed"].includes(row.status) || Boolean(row.acknowledgedAt || row.acceptedAt || row.completedAt);
}

function verifiedEffect(effect: EffectInspection): boolean {
  return effect.status === "verified" && effect.verification?.state === "verified";
}

function effectIsBusinessEvidence(effect: EffectInspection): boolean {
  if (!verifiedEffect(effect)) return false;
  if (effect.effect.expected.observation === "canonical_state" && effect.effect.expected.state) return true;
  return /\bcanonical\b/i.test(effect.verification?.basis ?? "");
}

async function queryCriterion(params: {
  tenantId: string;
  workId: string;
  request: OperationalQueryRequest;
  assertion: ObjectiveSuccessAssertion;
  executionKey: string;
}): Promise<{ satisfied: boolean; basis: string; evidenceRefs: Array<{ type: string; id: string }>; observed: unknown; queryExecutionId?: string }> {
  const result = await executeTenantOperationalQuery(params.tenantId, params.request as CanonicalOperationalQueryRequest, { workId: params.workId, executionKey: params.executionKey });
  const assertion = evaluateObjectiveAssertion(result, params.assertion);
  const executionId = result.execution?.id;
  return {
    satisfied: assertion.satisfied,
    basis: assertion.satisfied ? "The current Operational Query result satisfies the persisted assertion." : "The current Operational Query result does not satisfy the persisted assertion.",
    evidenceRefs: executionId ? [{ type: "work_query_execution", id: executionId }] : [],
    observed: { path: params.assertion.path, operator: params.assertion.operator, expected: params.assertion.expected, actual: assertion.actual },
    queryExecutionId: executionId,
  };
}

async function privateEquityTruthCriterion(params: {
  tenantId: string;
  criterion: Extract<ObjectiveSuccessCriterion, { kind: "private_equity_truth" }>;
}): Promise<Omit<ObjectiveSuccessCriterionResult, "index" | "kind">> {
  const ctx: PeMutationContext = { auth: { tenantId: params.tenantId, userId: "system:objective-success", role: "owner" } };
  const graph = await loadDealExecutionGraph(ctx, params.criterion.dealId);
  const eligibility = await evaluateDealCloseEligibility(ctx, params.criterion.dealId);
  const collections: Partial<Record<typeof params.criterion.entityType, Array<Record<string, unknown>>>> = {
    pe_request: graph.requests,
    pe_finding: graph.findings,
    pe_deal_risk: graph.dealRisks,
    pe_closing_condition: graph.closingConditions,
    pe_closing_item: graph.closingItems,
  };
  const row = params.criterion.entityType === "pe_deal"
    ? (String(graph.deal.id) === params.criterion.entityId ? graph.deal : null)
    : collections[params.criterion.entityType]?.find((candidate) => String(candidate.id) === params.criterion.entityId) ?? null;
  let satisfied = false;
  let observed: Record<string, unknown> = { entityType: params.criterion.entityType, entityId: params.criterion.entityId, missing: !row };
  if (row && params.criterion.requirement.kind === "state_in") {
    const state = String(row.state ?? row.status ?? "");
    const invalidWaiver = params.criterion.entityType === "pe_closing_condition" && state === "waived"
      && eligibility.invalidWaivers.some((waiver) => waiver.id === params.criterion.entityId);
    satisfied = params.criterion.requirement.states.includes(state) && !invalidWaiver;
    observed = { state, acceptedStates: params.criterion.requirement.states, invalidWaiver };
  } else if (row && params.criterion.requirement.kind === "close_eligible") {
    satisfied = eligibility.eligible;
    observed = { eligibility };
  } else if (row && params.criterion.requirement.kind === "deal_closed") {
    const closeEvent = graph.businessEvents.find((event) => event.eventType === "pe_deal_closed" && String(event.entityId) === params.criterion.entityId);
    const receipt = graph.decisionReceipts.find((candidate) => candidate.id === row.closeDecisionReceiptId);
    const finalized = Boolean(receipt?.finalizedAt) && !receipt?.failure;
    satisfied = row.status === "closed" && Boolean(row.actualCloseAt) && Boolean(closeEvent) && finalized;
    observed = {
      state: row.status,
      actualCloseAt: row.actualCloseAt ?? null,
      closeEventId: closeEvent?.id ?? null,
      decisionReceiptId: receipt?.id ?? null,
      receiptFinalized: finalized,
    };
  }
  return {
    satisfied,
    basis: satisfied
      ? "Current PE2 canonical truth satisfies the persisted objective contract."
      : "Current PE2 canonical truth does not yet satisfy the persisted objective contract.",
    evidenceRefs: row ? [{ type: params.criterion.entityType, id: params.criterion.entityId }] : [],
    observed,
  };
}

export async function evaluateObjectiveSuccessCondition(params: {
  tenantId: string;
  workId: string;
  loopId: string;
  stepNumber: number;
  condition: ObjectiveSuccessCondition;
  inspection: ObjectiveSuccessInspection;
  evidence: ObjectiveCompletionEvidence[];
}): Promise<ObjectiveSuccessVerification> {
  const results: ObjectiveSuccessCriterionResult[] = [];
  const queryExecutionIds: string[] = [];
  const add = (index: number, criterion: ObjectiveSuccessCriterion, result: Omit<ObjectiveSuccessCriterionResult, "index" | "kind">) => results.push({ index, kind: criterion.kind, ...result });

  const validateEvidence = async (item: ObjectiveCompletionEvidence, index: number): Promise<ObjectiveSuccessCriterionResult> => {
    if (item.kind === "canonical_query") {
      const result = await queryCriterion({ tenantId: params.tenantId, workId: params.workId, request: item.request, assertion: item.assertion, executionKey: `objective:${params.loopId}:step:${params.stepNumber}:success:evidence:${index}` });
      if (result.queryExecutionId) queryExecutionIds.push(result.queryExecutionId);
      return { index, kind: "decision_evidence", satisfied: result.satisfied, basis: result.basis, evidenceRefs: result.evidenceRefs, observed: result.observed };
    }
    if (item.kind === "business_effect") {
      const effect = params.inspection.businessEffects.find((row) => row.id === item.businessEffectId);
      const satisfied = Boolean(effect && effectIsBusinessEvidence(effect));
      return { index, kind: "decision_evidence", satisfied, basis: satisfied ? "The exact objective Business Effect is verified by canonical business state." : "The cited Business Effect is missing, unverified, or proves only provider/workflow completion.", evidenceRefs: effect ? [{ type: "business_effect", id: effect.id }] : [] };
    }
    if (item.kind === "matched_event") {
      const event = params.inspection.integrationEvents.find((row) => row.id === item.integrationEventId);
      const wait = params.inspection.eventWaits.find((row) => row.matchedEventId === item.integrationEventId && row.status === "satisfied");
      const satisfied = Boolean(event && wait);
      return { index, kind: "decision_evidence", satisfied, basis: satisfied ? "The exact tenant-scoped wait was satisfied by the cited integration event." : "The cited event did not satisfy an exact wait owned by this objective.", evidenceRefs: event ? [{ type: "integration_event", id: event.id }, ...(wait ? [{ type: "work_event_wait", id: wait.id }] : [])] : [] };
    }
    if (item.kind === "delegation") {
      const delegation = params.inspection.delegations.find((row) => row.id === item.delegationId);
      const satisfied = Boolean(delegation && delegationReached(delegation, item.requiredStatus));
      return { index, kind: "decision_evidence", satisfied, basis: satisfied ? `The exact delegation reached ${item.requiredStatus}.` : `The exact delegation has not reached ${item.requiredStatus}.`, evidenceRefs: delegation ? [{ type: "delegation", id: delegation.id }] : [] };
    }
    const run = params.inspection.computerRuns.find((row) => row.id === item.computerRunId);
    const evidenceSatisfied = item.evidenceRequired === false || Boolean(run?.evidence?.length);
    const satisfied = run?.status === "succeeded" && evidenceSatisfied;
    return { index, kind: "decision_evidence", satisfied, basis: satisfied ? "The exact governed computer run succeeded with the required evidence." : "The exact governed computer run is not a verified success with required evidence.", evidenceRefs: run ? [{ type: "computer_run", id: run.id }] : [] };
  };

  for (let index = 0; index < params.condition.criteria.length; index += 1) {
    const criterion = params.condition.criteria[index]!;
    if (criterion.kind === "no_open_execution") {
      const openActions = params.inspection.actions.filter((row) => ["draft", "pending", "approved", "executing", "needs_human_review", "blocked_integration_unavailable"].includes(row.status));
      const openOperations = params.inspection.operations.filter((row) => ["awaiting_approval", "queued", "running", "needs_human_review"].includes(row.status));
      add(index, criterion, { satisfied: openActions.length === 0 && openOperations.length === 0, basis: openActions.length || openOperations.length ? "Execution, approval, or recovery responsibility is still open." : "No objective execution or approval responsibility remains open.", evidenceRefs: [...openActions.map((row) => ({ type: "domain_action", id: row.id })), ...openOperations.map((row) => ({ type: "business_operation", id: row.id }))] });
    } else if (criterion.kind === "all_objective_effects_verified") {
      const effects = params.inspection.businessEffects;
      const satisfied = effects.length >= criterion.minimumCount && effects.every(verifiedEffect);
      add(index, criterion, { satisfied, basis: satisfied ? `All ${effects.length} objective Business Effects are verified.` : `Only ${effects.filter(verifiedEffect).length} of ${effects.length} objective Business Effects are verified; minimum ${criterion.minimumCount}.`, evidenceRefs: effects.map((row) => ({ type: "business_effect", id: row.id })), observed: effects.map((row) => ({ id: row.id, status: row.status, verification: row.verification?.state ?? null })) });
    } else if (criterion.kind === "canonical_query") {
      const result = await queryCriterion({ tenantId: params.tenantId, workId: params.workId, request: criterion.request, assertion: criterion.assertion, executionKey: `objective:${params.loopId}:step:${params.stepNumber}:success:criterion:${index}` });
      if (result.queryExecutionId) queryExecutionIds.push(result.queryExecutionId);
      add(index, criterion, result);
    } else if (criterion.kind === "private_equity_truth") {
      add(index, criterion, await privateEquityTruthCriterion({ tenantId: params.tenantId, criterion }));
    } else if (criterion.kind === "matched_wait") {
      const waits = params.inspection.eventWaits.filter((row) => row.status === "satisfied" && row.matchedEventId && (!criterion.eventType || row.expectedEventType === criterion.eventType));
      add(index, criterion, { satisfied: waits.length >= criterion.minimumCount, basis: `${waits.length} exact objective waits satisfy the required event outcome; minimum ${criterion.minimumCount}.`, evidenceRefs: waits.flatMap((row) => [{ type: "work_event_wait", id: row.id }, ...(row.matchedEventId ? [{ type: "integration_event", id: row.matchedEventId }] : [])]) });
    } else if (criterion.kind === "delegation_state") {
      const rows = params.inspection.delegations.filter((row) => delegationReached(row, criterion.requiredStatus));
      add(index, criterion, { satisfied: rows.length >= criterion.minimumCount, basis: `${rows.length} delegations reached ${criterion.requiredStatus}; minimum ${criterion.minimumCount}.`, evidenceRefs: rows.map((row) => ({ type: "delegation", id: row.id })) });
    } else if (criterion.kind === "computer_run_state") {
      const rows = params.inspection.computerRuns.filter((row) => row.status === criterion.requiredStatus && (!criterion.evidenceRequired || Boolean(row.evidence?.length)));
      add(index, criterion, { satisfied: rows.length >= criterion.minimumCount, basis: `${rows.length} governed computer runs reached verified success; minimum ${criterion.minimumCount}.`, evidenceRefs: rows.map((row) => ({ type: "computer_run", id: row.id })) });
    } else if (criterion.kind === "decision_evidence") {
      const accepted = params.evidence.filter((item) => criterion.accepted.includes(item.kind));
      const checked: ObjectiveSuccessCriterionResult[] = [];
      for (let evidenceIndex = 0; evidenceIndex < accepted.length; evidenceIndex += 1) checked.push(await validateEvidence(accepted[evidenceIndex]!, evidenceIndex));
      const verified = checked.filter((row) => row.satisfied);
      add(index, criterion, { satisfied: verified.length >= criterion.minimumCount, basis: `${verified.length} completion evidence items were deterministically verified; minimum ${criterion.minimumCount}.`, evidenceRefs: verified.flatMap((row) => row.evidenceRefs), observed: checked.map((row) => ({ satisfied: row.satisfied, basis: row.basis })) });
    } else {
      add(index, criterion, { satisfied: false, basis: criterion.reason, evidenceRefs: [] });
    }
  }
  const blocked = params.condition.criteria.some((criterion, index) => criterion.kind === "manual_verification" && !results[index]?.satisfied);
  return {
    version: 1,
    state: results.every((row) => row.satisfied) ? "verified" : blocked ? "blocked" : "unsatisfied",
    checkedAt: new Date().toISOString(),
    conditionHash: hash(params.condition),
    results,
    evidence: params.evidence,
    queryExecutionIds,
  };
}
