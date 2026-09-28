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
  MAX_HIGH_EGRESS_ROWS,
  businessEffects,
  businessOperations,
  computerArtifacts,
  computerRuns,
  delegations,
  domainActions,
  integrationEvents,
  withTenant,
  workEventWaits,
  workEntityLinks,
  works,
} from "@finnor/db";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { validateOperationalQueryRequest } from "./fast-read-lane";
import { executeTenantOperationalQuery } from "./operational-query-runtime";
import { evaluateDealCloseEligibility, getIcWorkspace, loadDealExecutionGraph, peTransaction, type PeMutationContext, type IcWorkspaceReadModel } from "@finnor/private-equity";
import { artifactContext, getArtifact } from "@finnor/artifacts";

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
  z.object({ kind: z.literal("private_equity_ic_preparation"), dealId: z.string().uuid(), requireScenario: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("private_equity_ic_deck_draft"), dealId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("private_equity_underwriting_scenario"), dealId: z.string().uuid(), growthDecreaseBps: z.number().int().min(1).max(10_000), exitMultiple: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/) }).strict(),
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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

/** Only an explicit growth-rate decrease and exit multiple qualify for this exact financial contract. */
export function exactGrowthAndExitRequest(objective: string): { growthDecreaseBps: number; exitMultiple: string } | null {
  const growth = /\b(?:revenue\s+)?growth\s+(?:down|lower(?:ed)?\s+by|reduc(?:e|ed)\s+by)\s+(\d{1,5})\s*(?:bps|basis\s+points)\b/i.exec(objective);
  const exit = /\bexit(?:\s+multiple)?\s+(?:at|to)\s+((?:0|[1-9]\d*)(?:\.\d+)?)\s*x\b/i.exec(objective);
  if (!growth || !exit) return null;
  const growthDecreaseBps = Number(growth[1]);
  if (!Number.isInteger(growthDecreaseBps) || growthDecreaseBps < 1 || growthDecreaseBps > 10_000 || Number(exit[1]) <= 0) return null;
  return { growthDecreaseBps, exitMultiple: exit[1]! };
}

/** Exact decimal arithmetic; 300bps means subtract 0.03 from each recorded growth rate. */
export function growthRateLessBps(value: unknown, decreaseBps: number): string | null {
  if (typeof value !== "string" || !Number.isInteger(decreaseBps) || decreaseBps < 1 || decreaseBps > 10_000) return null;
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const scale = Math.max(match[3]?.length ?? 0, 4);
  const factor = 10n ** BigInt(scale);
  const units = BigInt(match[2]!) * factor + BigInt((match[3] ?? "").padEnd(scale, "0") || "0");
  const result = (match[1] ? -units : units) - BigInt(decreaseBps) * 10n ** BigInt(scale - 4);
  if (result < -factor) return null;
  const absolute = result < 0n ? -result : result;
  const fraction = (absolute % factor).toString().padStart(scale, "0").replace(/0+$/, "");
  return `${result < 0n ? "-" : ""}${absolute / factor}${fraction ? `.${fraction}` : ""}`;
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
  const icPreparation = /\b(?:prepare|preparing|preparation)\b.{0,120}\b(?:ic|investment committee)\b|\b(?:ic|investment committee)\b.{0,120}\b(?:prepare|preparing|preparation)\b/.test(normalized);
  const revenueChallenge = /\bchallenge\b.{0,120}\b(?:revenue|assumption)\b|\b(?:revenue|assumption)\b.{0,120}\bchallenge\b/.test(normalized);
  const dealRecheck = /\brecheck\b.{0,120}\bdeal\b.{0,120}\b(?:ic|investment committee)\b/.test(normalized);
  const icDeck = /\b(?:turn|create|make|prepare|build)\b.{0,150}\b(?:ic|investment committee)\b.{0,40}\b(?:deck|slides|presentation)\b/.test(normalized);
  if (icDeck && !revenueChallenge) return {
    version: 1, statement: params.objective.trim(), mode: "all", source: "objective_first_policy",
    criteria: [
      { kind: "no_open_execution" },
      { kind: "all_objective_effects_verified", minimumCount: 1 },
      { kind: "private_equity_ic_deck_draft", dealId: params.dealId },
      { kind: "decision_evidence", minimumCount: 1, accepted: ["business_effect"] },
    ],
  };
  if (dealRecheck) return {
    version: 1,
    statement: params.objective.trim(),
    mode: "all",
    source: "objective_first_policy",
    criteria: [
      { kind: "no_open_execution" },
      { kind: "all_objective_effects_verified", minimumCount: 0 },
      { kind: "canonical_query", request: { intent: "pe_world_state", root: { entityType: "pe_deal", entityId: params.dealId } }, assertion: { path: ["root", "entityId"], operator: "eq", expected: params.dealId } },
      { kind: "canonical_query", request: { intent: "open_findings", dealId: params.dealId }, assertion: { path: ["status"], operator: "eq", expected: "ok" } },
      { kind: "canonical_query", request: { intent: "open_deal_risks", dealId: params.dealId }, assertion: { path: ["status"], operator: "eq", expected: "ok" } },
    ],
  };
  if (icPreparation) return {
    version: 1,
    statement: params.objective.trim(),
    mode: "all",
    source: "objective_first_policy",
    criteria: [
      { kind: "no_open_execution" },
      { kind: "all_objective_effects_verified", minimumCount: 0 },
      { kind: "private_equity_ic_preparation", dealId: params.dealId, ...(revenueChallenge ? { requireScenario: true } : {}) },
      { kind: "decision_evidence", minimumCount: 1, accepted: ["canonical_query", "business_effect"] },
    ],
  };
  const financialScenario = exactGrowthAndExitRequest(params.objective);
  if (financialScenario) return {
    version: 1,
    statement: params.objective.trim(),
    mode: "all",
    source: "objective_first_policy",
    criteria: [
      { kind: "no_open_execution" },
      { kind: "all_objective_effects_verified", minimumCount: 1 },
      { kind: "private_equity_underwriting_scenario", dealId: params.dealId, ...financialScenario },
      { kind: "decision_evidence", minimumCount: 1, accepted: ["business_effect"] },
    ],
  };
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

/** A redirect may change the requested outcome, but a Deal-scoped Objective
 * must retain its canonical Deal scope when no new explicit contract is given. */
export function redirectedObjectiveSuccessCondition(current: ObjectiveSuccessCondition, objective: string): ObjectiveSuccessCondition {
  const scoped = current.criteria.find((criterion) => criterion.kind === "private_equity_ic_preparation" || criterion.kind === "private_equity_ic_deck_draft" || criterion.kind === "private_equity_underwriting_scenario" || criterion.kind === "private_equity_truth");
  if (!scoped) return defaultObjectiveSuccessCondition(objective);
  const truthSubject = scoped.kind === "private_equity_truth" && scoped.entityType !== "pe_deal"
    ? { entityType: scoped.entityType, entityId: scoped.entityId } : undefined;
  return privateEquityObjectiveSuccessCondition({ objective, dealId: scoped.dealId, ...(truthSubject ? { subject: truthSubject } : {}) });
}

type EffectInspection = {
  id: string;
  domainActionId: string | null;
  status: string;
  effect: BusinessEffectSet;
  verification: BusinessEffectVerification | null;
};

export interface ObjectiveSuccessInspection {
  actions: Array<{ id: string; actionType: string; status: string }>;
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
    const bounded = <T>(table: string, rows: T[]): T[] => {
      if (rows.length > MAX_HIGH_EGRESS_ROWS) {
        throw new Error(`Objective success read exceeded ${MAX_HIGH_EGRESS_ROWS} rows for ${table}; completion is stopped until the evidence is narrowed`);
      }
      return rows;
    };
    const actions = bounded("domain_actions", await db.select({ id: domainActions.id, actionType: domainActions.actionType, status: domainActions.status })
      .from(domainActions)
      .where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.workId, workId)))
      .orderBy(asc(domainActions.createdAt), asc(domainActions.id))
      .limit(MAX_HIGH_EGRESS_ROWS + 1));
    const actionIds = actions.map((row) => row.id);
    const effects = actionIds.length === 0 ? [] : bounded("business_effects", await db.select({
      id: businessEffects.id,
      domainActionId: businessEffects.domainActionId,
      status: businessEffects.status,
      effect: businessEffects.effect,
      verification: businessEffects.verification,
    }).from(businessEffects).where(and(
      eq(businessEffects.tenantId, tenantId),
      inArray(businessEffects.domainActionId, actionIds),
    )).orderBy(asc(businessEffects.createdAt), asc(businessEffects.id)).limit(MAX_HIGH_EGRESS_ROWS + 1));
    const operations = bounded("business_operations", await db.select({ id: businessOperations.id, status: businessOperations.status })
      .from(businessOperations)
      .where(and(eq(businessOperations.tenantId, tenantId), eq(businessOperations.workId, workId)))
      .orderBy(asc(businessOperations.createdAt), asc(businessOperations.id))
      .limit(MAX_HIGH_EGRESS_ROWS + 1));
    const delegationRows = bounded("delegations", await db.select({
      id: delegations.id,
      status: delegations.status,
      acknowledgedAt: delegations.acknowledgedAt,
      acceptedAt: delegations.acceptedAt,
      completedAt: delegations.completedAt,
    }).from(delegations).where(and(eq(delegations.tenantId, tenantId), eq(delegations.workId, workId))).orderBy(asc(delegations.createdAt), asc(delegations.id)).limit(MAX_HIGH_EGRESS_ROWS + 1));
    const runRows = bounded("computer_runs", await db.select({ id: computerRuns.id, status: computerRuns.status, result: computerRuns.result })
      .from(computerRuns)
      .where(and(eq(computerRuns.tenantId, tenantId), eq(computerRuns.workId, workId)))
      .orderBy(asc(computerRuns.createdAt), asc(computerRuns.id))
      .limit(MAX_HIGH_EGRESS_ROWS + 1));
    const runIds = runRows.map((row) => row.id);
    const artifacts = runIds.length === 0 ? [] : bounded("computer_artifacts", await db.select({ id: computerArtifacts.id, runId: computerArtifacts.runId })
      .from(computerArtifacts)
      .where(and(eq(computerArtifacts.tenantId, tenantId), inArray(computerArtifacts.runId, runIds)))
      .orderBy(asc(computerArtifacts.createdAt), asc(computerArtifacts.id))
      .limit(MAX_HIGH_EGRESS_ROWS + 1));
    const waits = bounded("work_event_waits", await db.select({
      id: workEventWaits.id,
      status: workEventWaits.status,
      expectedEventType: workEventWaits.expectedEventType,
      matchedEventId: workEventWaits.matchedEventId,
    }).from(workEventWaits).where(and(
      eq(workEventWaits.tenantId, tenantId),
      eq(workEventWaits.objectiveLoopId, objectiveLoopId),
    )).orderBy(asc(workEventWaits.createdAt), asc(workEventWaits.id)).limit(MAX_HIGH_EGRESS_ROWS + 1));
    const matchedEventIds = waits.flatMap((row) => row.matchedEventId ? [row.matchedEventId] : []);
    const eventScope = matchedEventIds.length > 0
      ? or(eq(integrationEvents.workId, workId), inArray(integrationEvents.id, matchedEventIds))!
      : eq(integrationEvents.workId, workId);
    const events = bounded("integration_events", await db.select({
      id: integrationEvents.id,
      eventType: integrationEvents.eventType,
      status: integrationEvents.status,
      workId: integrationEvents.workId,
    }).from(integrationEvents).where(and(eq(integrationEvents.tenantId, tenantId), eventScope)).orderBy(asc(integrationEvents.receivedAt), asc(integrationEvents.id)).limit(MAX_HIGH_EGRESS_ROWS + 1));
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

/** Cite the exact completed IC review action only when its Work-scoped effect
 * already verifies canonical review readiness. The terminal verifier reloads
 * this effect again; this selection itself never grants completion. */
export function icReviewCompletionEvidence(inspection: ObjectiveSuccessInspection): Extract<ObjectiveCompletionEvidence, { kind: "business_effect" }> | null {
  const reviewIds = new Set(inspection.actions.filter((action) =>
    action.actionType === "request_ic_memo_review" && action.status === "completed").map((action) => action.id));
  const effect = inspection.businessEffects.find((item) => item.domainActionId && reviewIds.has(item.domainActionId)
    && item.effect.expected.observation === "canonical_state"
    && item.effect.expected.state?.state === "READY_FOR_REVIEW"
    && effectIsBusinessEvidence(item));
  return effect ? { kind: "business_effect", businessEffectId: effect.id } : null;
}

/** The completion check still validates the exact scenario and Run independently. */
export function underwritingCompletionEvidence(inspection: ObjectiveSuccessInspection): Extract<ObjectiveCompletionEvidence, { kind: "business_effect" }> | null {
  const actionIds = new Set(inspection.actions.filter((action) => action.actionType === "create_underwriting_run" && action.status === "completed").map((action) => action.id));
  const effect = inspection.businessEffects.find((item) => item.domainActionId && actionIds.has(item.domainActionId) && effectIsBusinessEvidence(item));
  return effect ? { kind: "business_effect", businessEffectId: effect.id } : null;
}

export function icDeckCompletionEvidence(inspection: ObjectiveSuccessInspection): Extract<ObjectiveCompletionEvidence, { kind: "business_effect" }> | null {
  const actionIds = new Set(inspection.actions.filter((action) => action.actionType === "create_ic_deck_draft" && action.status === "completed").map((action) => action.id));
  const effect = inspection.businessEffects.find((item) => item.domainActionId && actionIds.has(item.domainActionId) && effectIsBusinessEvidence(item));
  return effect ? { kind: "business_effect", businessEffectId: effect.id } : null;
}

async function privateEquityIcDeckCriterion(params: { tenantId: string; workId: string; dealId: string }): Promise<Omit<ObjectiveSuccessCriterionResult, "index" | "kind">> {
  const rows = await withTenant(params.tenantId, async (db) => (await db.execute(sql`
    SELECT action.id::text action_id,action.initiated_by actor_id,action.payload,
           effect.id::text effect_id,effect.observed_result,receipt.id::text receipt_id,
           link.document_id::text document_id
    FROM finnor_os.domain_actions action
    JOIN finnor_os.business_effects effect ON effect.tenant_id=action.tenant_id AND effect.domain_action_id=action.id
    JOIN finnor_os.decision_receipts receipt ON receipt.tenant_id=action.tenant_id AND receipt.domain_action_id=action.id
    JOIN finnor_os.pe_document_links link ON link.tenant_id=action.tenant_id AND link.deal_id=${params.dealId}::uuid
      AND link.entity_type='pe_ic_case' AND link.entity_id::text=action.payload->>'icCaseId'
      AND link.id::text=(effect.observed_result #>> '{entity,entityId}') AND link.archived_at IS NULL
    WHERE action.tenant_id=${params.tenantId}::uuid AND action.work_id=${params.workId}::uuid
      AND action.action_type='create_ic_deck_draft' AND action.status='completed'
      AND effect.status='verified' AND effect.verification->>'state'='verified'
      AND receipt.finalized_at IS NOT NULL AND receipt.failure IS NULL
    ORDER BY action.created_at DESC LIMIT 5
  `)).rows as Record<string, unknown>[]);
  for (const row of rows) {
    const payload = record(row.payload);
    const state = record(record(row.observed_result).canonicalState);
    const versionId = String(state.documentVersionId ?? "");
    if (payload.dealId !== params.dealId || !/^[0-9a-f-]{36}$/i.test(versionId)) continue;
    const actor = { tenantId: params.tenantId, userId: String(row.actor_id), role: "owner" as const };
    const artifact = await getArtifact(actor, String(row.document_id), versionId);
    const { bindings } = await artifactContext(actor, String(row.document_id), versionId);
    const textNodes = artifact.ir.nodes.filter((node) => node.kind === "shape" && typeof node.data.text === "string" && node.data.text.trim());
    const sourceKinds = new Set(bindings.map((binding) => String(binding.target_entity_type ?? binding.target_kind)));
    const anchorsValid = bindings.length > 0 && bindings.every((binding) => artifact.ir.nodes.some((node) => node.id === binding.anchor_id && node.hash === binding.anchor_hash));
    if (artifact.ir.kind !== "pptx" || artifact.document.external_id !== row.action_id || artifact.version.source_ref !== payload.templateVersionId
      || textNodes.some((node) => String(node.data.text).includes("{{")) || textNodes.length < 4 || !anchorsValid
      || !sourceKinds.has("pe_ic_case") || !sourceKinds.has("underwriting_run")) continue;
    return {
      satisfied: true, basis: "The exact Work-created presentation contains sourced IC and Underwriting content, persisted anchor bindings, verified template lineage, and a finalized action receipt.",
      evidenceRefs: [{ type: "document_version", id: versionId }, { type: "pe_ic_case", id: String(payload.icCaseId) }, { type: "business_effect", id: String(row.effect_id) }, { type: "decision_receipt", id: String(row.receipt_id) }],
      observed: { documentId: row.document_id, versionId, semanticHash: artifact.ir.semanticHash, sourceBindingCount: bindings.length, sourceKinds: [...sourceKinds] },
    };
  }
  return { satisfied: false, basis: "No verified Work-created IC presentation has populated, bound source content and its finalized receipt.", evidenceRefs: [], observed: { candidateCount: rows.length } };
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

/** A prepared IC case has a new, Work-linked underwriting and memo basis. The
 * existing historical Atlas pin alone cannot satisfy a fresh Objective. */
export function assessPrivateEquityIcPreparation(input: {
  workspace: IcWorkspaceReadModel;
  workId: string;
  workCreatedAt: Date | string;
  memoContentVerified: boolean;
  requireScenario?: boolean;
}): { satisfied: boolean; gaps: string[] } {
  const { workspace } = input;
  const preparedStates = new Set(["READY_FOR_REVIEW", "QUESTIONS_OPEN", "READY_FOR_VOTE", "VOTING", "CONDITIONS_PENDING"]);
  const workTime = new Date(input.workCreatedAt).getTime();
  const runTime = new Date(String(workspace.underwriting?.run.computedAt ?? "")).getTime();
  const memoTime = new Date(String(workspace.artifacts.memo?.createdAt ?? "")).getTime();
  const gaps = [
    ...(!preparedStates.has(String(workspace.case.state)) ? ["IC_CASE_NOT_PREPARED"] : []),
    ...(!workspace.underwriting?.eligibleUnderPinnedPolicy ? ["UNDERWRITING_BASIS_NOT_ELIGIBLE"] : []),
    ...(workspace.underwriting?.run.workId !== input.workId ? ["UNDERWRITING_NOT_LINKED_TO_WORK"] : []),
    ...(!Number.isFinite(workTime) || !Number.isFinite(runTime) || runTime < workTime ? ["NO_FRESH_UNDERWRITING_RUN"] : []),
    ...(input.requireScenario && !workspace.underwriting?.run.scenarioId ? ["NO_UNDERWRITING_SCENARIO"] : []),
    ...(!workspace.memo || !workspace.artifacts.memo ? ["MEMO_VERSION_MISSING"] : []),
    ...(!Number.isFinite(workTime) || !Number.isFinite(memoTime) || memoTime < workTime ? ["NO_FRESH_MEMO_VERSION"] : []),
    ...(!input.memoContentVerified || workspace.artifacts.memo?.parseStatus !== "parsed" ? ["MEMO_CONTENT_NOT_VERIFIED"] : []),
    ...(workspace.memo?.sourceCompleteness !== "COMPLETE" ? ["MEMO_SOURCE_INCOMPLETE"] : []),
    ...(!workspace.currentRecommendation
      || workspace.currentRecommendation.memoId !== workspace.case.currentMemoId
      || workspace.currentRecommendation.underwritingRunId !== workspace.case.primaryUnderwritingRunId
      ? ["RECOMMENDATION_BASIS_MISMATCH"] : []),
    ...(workspace.readiness.blockers.length ? ["IC_READINESS_BLOCKED"] : []),
  ];
  return { satisfied: gaps.length === 0, gaps };
}

async function privateEquityIcPreparationCriterion(params: {
  tenantId: string;
  workId: string;
  dealId: string;
  requireScenario?: boolean;
}): Promise<Omit<ObjectiveSuccessCriterionResult, "index" | "kind">> {
  const { work, caseIds } = await withTenant(params.tenantId, async (db) => {
    const [work] = await db.select({ createdAt: works.createdAt }).from(works).where(and(
      eq(works.tenantId, params.tenantId), eq(works.id, params.workId),
    )).limit(1);
    const links = await db.select({ entityId: workEntityLinks.entityId }).from(workEntityLinks).where(and(
      eq(workEntityLinks.tenantId, params.tenantId),
      eq(workEntityLinks.workId, params.workId),
      eq(workEntityLinks.entityType, "pe_ic_case"),
      inArray(workEntityLinks.relationship, ["about", "target", "result"]),
    )).limit(26);
    return { work, caseIds: links.map((link) => link.entityId) };
  });
  if (!work || caseIds.length === 0 || caseIds.length > 25) return {
    satisfied: false,
    basis: caseIds.length > 25 ? "Too many IC Case links to verify exactly." : "No exact IC Case is linked to this Work.",
    evidenceRefs: [],
    observed: { linkedCaseCount: caseIds.length },
  };
  const ctx: PeMutationContext = { auth: { tenantId: params.tenantId, userId: "system:objective-success", role: "owner" } };
  const observations: Array<{ caseId: string; gaps: string[] }> = [];
  for (const caseId of caseIds) {
    const workspace = await getIcWorkspace(ctx, { icCaseId: caseId });
    if (workspace.case.dealId !== params.dealId) {
      observations.push({ caseId, gaps: ["IC_CASE_WRONG_DEAL"] });
      continue;
    }
    const versionId = workspace.artifacts.memo?.documentVersionId;
    const memoContentVerified = typeof versionId === "string" && await peTransaction(ctx, async (_db, client) => {
      const result = await client.query<{ valid: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM finnor_os.document_version_contents content
          JOIN finnor_os.document_versions version
            ON version.tenant_id=content.tenant_id AND version.id=content.version_id
          WHERE content.tenant_id=$1 AND content.version_id=$2
            AND content.storage_backend='postgres' AND content.bytes IS NOT NULL
            AND content.sha256=version.byte_sha256 AND content.size_bytes=version.size_bytes
        ) valid`,
        [params.tenantId, versionId],
      );
      return result.rows[0]?.valid === true;
    }, { readOnly: true });
    const assessment = assessPrivateEquityIcPreparation({
      workspace,
      workId: params.workId,
      workCreatedAt: work.createdAt,
      memoContentVerified,
      requireScenario: params.requireScenario,
    });
    if (assessment.satisfied) return {
      satisfied: true,
      basis: "The Work-linked IC Case has a fresh eligible underwriting run, persisted memo content, exact recommendation, and an unblocked review basis.",
      evidenceRefs: [
        { type: "pe_ic_case", id: caseId },
        { type: "underwriting_run", id: String(workspace.case.primaryUnderwritingRunId) },
        { type: "document_version", id: String(versionId) },
        { type: "pe_ic_recommendation", id: String(workspace.case.currentRecommendationId) },
      ],
      observed: { caseId, state: workspace.case.state, asOf: workspace.asOf },
    };
    observations.push({ caseId, gaps: assessment.gaps });
  }
  return {
    satisfied: false,
    basis: "No Work-linked IC Case has a fresh, verified underwriting and Artifact basis ready for review.",
    evidenceRefs: observations.map((row) => ({ type: "pe_ic_case", id: row.caseId })),
    observed: observations,
  };
}

/** Verify the requested financial deltas against the current immutable base and
 * Work-linked branch records. A similar Scenario from another Work cannot pass. */
async function privateEquityUnderwritingScenarioCriterion(params: {
  tenantId: string; workId: string; dealId: string; growthDecreaseBps: number; exitMultiple: string;
}): Promise<Omit<ObjectiveSuccessCriterionResult, "index" | "kind">> {
  const rows = await withTenant(params.tenantId, async (db) => (await db.execute(sql`
    SELECT action.id::text action_id,action.status action_status,action.payload,
           effect.id::text effect_id,effect.status effect_status,effect.verification,effect.observed_result,
           receipt.id::text receipt_id,receipt.finalized_at,receipt.failure receipt_failure,
           branch.id::text branch_id,branch.status branch_status,branch.validity branch_validity,
           branch.investment_case_id::text investment_case_id,branch.model_version_id::text model_version_id,
           branch.world_at branch_world_at,branch.input_snapshot branch_snapshot,
           scenario.id::text scenario_id,scenario.definition scenario_definition,
           base.id::text base_id,base.status base_status,base.validity base_validity,
           base.investment_case_id::text base_investment_case_id,base.model_version_id::text base_model_version_id,
           base.world_at base_world_at,base.scenario_id::text base_scenario_id,base.input_snapshot base_snapshot,
           investment.deal_id::text deal_id
    FROM finnor_os.domain_actions action
    JOIN finnor_os.business_effects effect ON effect.tenant_id=action.tenant_id AND effect.domain_action_id=action.id
    JOIN finnor_os.decision_receipts receipt ON receipt.tenant_id=action.tenant_id AND receipt.domain_action_id=action.id
    JOIN finnor_os.underwriting_runs branch ON branch.tenant_id=action.tenant_id
      AND branch.work_id=action.work_id AND branch.id::text=(effect.observed_result #>> '{entity,entityId}')
    JOIN finnor_os.underwriting_scenarios scenario ON scenario.tenant_id=branch.tenant_id AND scenario.id=branch.scenario_id
    JOIN finnor_os.underwriting_runs base ON base.tenant_id=branch.tenant_id AND base.id::text=action.payload->>'baseRunId'
    JOIN finnor_os.pe_investment_cases investment ON investment.tenant_id=branch.tenant_id AND investment.id=branch.investment_case_id
    WHERE action.tenant_id=${params.tenantId}::uuid AND action.work_id=${params.workId}::uuid
      AND action.action_type='create_underwriting_run'
    ORDER BY action.created_at DESC LIMIT 10
  `)).rows as Record<string, unknown>[]);
  const gaps: Array<{ actionId: unknown; reason: string }> = [];
  for (const row of rows) {
    const payload = record(row.payload);
    const effectResult = record(row.observed_result);
    const effectEntity = record(effectResult.entity);
    const effectVerification = record(row.verification);
    const baseSnapshot = record(row.base_snapshot);
    const branchSnapshot = record(row.branch_snapshot);
    const baseValues = record(baseSnapshot.values);
    const branchValues = record(branchSnapshot.values);
    const baseGrowth = record(record(baseValues["operating.revenue_growth"]).value);
    const branchGrowth = record(record(branchValues["operating.revenue_growth"]).value);
    const basePeriods = Object.keys(baseGrowth).sort();
    const scenarioOverrides = record(row.scenario_definition).overrides;
    const overrides = Array.isArray(scenarioOverrides) ? scenarioOverrides.map(record) : [];
    const expectedGrowth = Object.fromEntries(basePeriods.map((period) => [period, growthRateLessBps(baseGrowth[period], params.growthDecreaseBps)]));
    const sameOtherInputs = Object.keys(baseValues).sort().join("|") === Object.keys(branchValues).sort().join("|")
      && Object.keys(baseValues).filter((nodeId) => !["operating.revenue_growth", "exit.multiple"].includes(nodeId))
        .every((nodeId) => canonical(baseValues[nodeId]) === canonical(branchValues[nodeId]));
    const exact = row.deal_id === params.dealId && payload.dealId === params.dealId
      && payload.baseRunId === row.base_id && payload.modelVersionId === row.model_version_id
      && payload.investmentCaseId === row.investment_case_id
      && row.action_status === "completed" && row.effect_status === "verified" && effectVerification.state === "verified"
      && row.finalized_at && !row.receipt_failure
      && effectEntity.entityType === "underwriting_run" && effectEntity.entityId === row.branch_id
      && row.branch_status === "SUCCEEDED" && row.branch_validity === "VALID"
      && row.base_status === "SUCCEEDED" && row.base_validity === "VALID" && !row.base_scenario_id
      && row.base_model_version_id === row.model_version_id && row.base_investment_case_id === row.investment_case_id
      && new Date(String(row.base_world_at)).getTime() === new Date(String(row.branch_world_at)).getTime()
      && basePeriods.length > 0 && basePeriods.length <= 240
      && Object.values(expectedGrowth).every((value) => value !== null)
      && canonical(branchGrowth) === canonical(expectedGrowth)
      && record(branchValues["exit.multiple"]).value === params.exitMultiple
      && overrides.length === 2
      && overrides.some((item) => item.nodeId === "operating.revenue_growth" && canonical(item.value) === canonical(expectedGrowth))
      && overrides.some((item) => item.nodeId === "exit.multiple" && item.value === params.exitMultiple)
      && sameOtherInputs;
    if (exact) return {
      satisfied: true,
      basis: `The Work-linked valid Run changed every recorded growth-rate period by exactly ${params.growthDecreaseBps}bps and set the exit multiple to ${params.exitMultiple}x; the base Run is unchanged.`,
      evidenceRefs: [
        { type: "underwriting_run", id: String(row.base_id) },
        { type: "underwriting_scenario", id: String(row.scenario_id) },
        { type: "underwriting_run", id: String(row.branch_id) },
        { type: "business_effect", id: String(row.effect_id) },
        { type: "decision_receipt", id: String(row.receipt_id) },
      ],
      observed: { baseRunId: row.base_id, scenarioId: row.scenario_id, branchRunId: row.branch_id, baseGrowth, branchGrowth, exitMultiple: params.exitMultiple },
    };
    gaps.push({ actionId: row.action_id, reason: "The exact governed Scenario, valid Run, Business Effect, receipt, or base comparison is incomplete." });
  }
  return { satisfied: false, basis: "No Work-linked, verified underwriting Run satisfies both requested financial deltas.", evidenceRefs: [], observed: { candidateCount: rows.length, gaps } };
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
    } else if (criterion.kind === "private_equity_ic_preparation") {
      add(index, criterion, await privateEquityIcPreparationCriterion({ tenantId: params.tenantId, workId: params.workId, dealId: criterion.dealId, requireScenario: criterion.requireScenario }));
    } else if (criterion.kind === "private_equity_ic_deck_draft") {
      add(index, criterion, await privateEquityIcDeckCriterion({ tenantId: params.tenantId, workId: params.workId, dealId: criterion.dealId }));
    } else if (criterion.kind === "private_equity_underwriting_scenario") {
      add(index, criterion, await privateEquityUnderwritingScenarioCriterion({ tenantId: params.tenantId, workId: params.workId, ...criterion }));
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
