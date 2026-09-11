import { randomUUID } from "node:crypto";
import { canExerciseAuthority, evaluateAuthority } from "@finnor/authority";
import { attachWorkEntityTx, type Db } from "@finnor/db";
import type { AuthorityDecision, TenantContext } from "@finnor/shared-types";
import { finalizeReceiptTx, openReceiptTx } from "@finnor/workflow-runtime";
import { aggregateIcDecision, icSemanticHash } from "./ic-aggregation";
import { recordIcMetric, type IcMetric } from "./ic-telemetry";
import {
  IC_CASE_TRANSITIONS,
  IC_CONDITION_TRANSITIONS,
  IC_QUESTION_TRANSITIONS,
  type IcAggregationInput,
  type IcAggregationResult,
  type IcCaseState,
  type IcCommitteeMemberSnapshot,
  type IcConditionSnapshot,
  type IcConditionState,
  type IcConditionType,
  type IcPolicySnapshot,
  type IcQuestionSnapshot,
  type IcQuestionState,
  type IcRecommendationOutcome,
  type IcSourceKind,
  type IcVoteChoice,
  type IcVoteSnapshot,
  type IcWorkspaceReadModel,
} from "./ic-types";
import {
  assertPeText,
  assertPeUuid,
  peProvenance,
  peTransaction,
  shapePeRow,
  type PeClient,
  type SqlRow,
} from "./repository";
import { finalizeDecisionTx, linkDecisionEffectsTx, recordDecisionTx } from "./world-repository";
import { PeDomainError, type GovernanceProof, type PeEntityType, type PeMutationContext, type PeMutationResult } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALIDITIES = new Set(["VALID", "INVALID", "INCOMPLETE", "NON_CONVERGENT"]);

interface IcCaseRow extends SqlRow {
  id: string;
  tenant_id: string;
  deal_id: string;
  investment_case_id: string;
  committee_config_version_id: string;
  primary_underwriting_run_id: string | null;
  current_memo_id: string | null;
  current_deck_id: string | null;
  current_recommendation_id: string | null;
  reconsiders_decision_id: string | null;
  final_decision_id: string | null;
  state: IcCaseState;
  version: number;
  vote_set_version: number;
  voting_basis_version: number | null;
  voting_opened_at: Date | null;
  voting_closed_at: Date | null;
  voting_open_idempotency_key: string | null;
  voting_close_idempotency_key: string | null;
}

interface IcQuestionRow extends SqlRow {
  id: string;
  tenant_id: string;
  deal_id: string;
  investment_case_id: string;
  ic_case_id: string;
  state: IcQuestionState;
  version: number;
  question: string;
}

interface IcConditionRow extends SqlRow {
  id: string;
  tenant_id: string;
  deal_id: string;
  investment_case_id: string;
  ic_case_id: string;
  state: IcConditionState;
  version: number;
  evidence_required: boolean;
}

export type IcSourceRef =
  | { kind: "EVIDENCE_VERSION"; evidenceVersionId: string }
  | { kind: "ARTIFACT_ANCHOR"; documentId: string; documentVersionId: string; anchorId: string; anchorHash: string }
  | { kind: "UNDERWRITING_RUN"; underwritingRunId: string }
  | { kind: "P1_WORLD"; entityType: PeEntityType; entityId: string }
  | { kind: "IC_QUESTION"; questionId: string }
  | { kind: "PE_RISK"; riskId: string }
  | { kind: "IC_CONDITION"; conditionId: string };

export interface IcSourceLinkInput {
  source: IcSourceRef;
  relationship: "SUPPORTS" | "CONTRADICTS" | "ANSWERS" | "VERIFIES" | "REQUIRES" | "REFERENCES";
  truthStatus?: "ATTACHED" | "CONFLICTING" | "STALE" | "UNKNOWN";
  idempotencyKey: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function emitIcMetric(
  ctx: PeMutationContext,
  metric: IcMetric,
  details: { icCaseId?: string; investmentCaseId?: string; entityId?: string; state?: string; result?: "success" | "blocked" | "failure" | "recovered" } = {},
): void {
  recordIcMetric({
    tenantId: ctx.auth.tenantId,
    traceId: ctx.auth.correlationId,
    actorId: ctx.auth.employeeId ?? ctx.auth.userId,
    operation: metric,
    ...details,
  }, metric);
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new PeDomainError("IC_BLOCKED_CONFIG", `${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new PeDomainError("IC_BLOCKED_CONFIG", `${label} must be explicitly boolean`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new PeDomainError("IC_BLOCKED_CONFIG", `${label} is unsupported`, { value, allowed });
  }
  return value as T;
}

/** Strict parser for the exact Core DomainPolicy snapshot pinned by a committee
 * configuration. Unsupported custom rules remain explicit BLOCKED_CONFIG. */
export function parseIcPolicySnapshot(value: unknown): IcPolicySnapshot {
  const raw = record(value);
  if (raw.schemaVersion !== "pe-ic-policy.v1") throw new PeDomainError("IC_BLOCKED_CONFIG", "IC policy schemaVersion must be pe-ic-policy.v1");
  const quorumRaw = record(raw.quorum);
  const quorumKind = oneOf(quorumRaw.kind, ["MIN_COUNT", "PERCENTAGE"] as const, "quorum.kind");
  const quorum = quorumKind === "MIN_COUNT"
    ? { kind: "MIN_COUNT" as const, minimum: integer(quorumRaw.minimum, "quorum.minimum", 1, 50) }
    : { kind: "PERCENTAGE" as const, basisPoints: integer(quorumRaw.basisPoints, "quorum.basisPoints", 1, 10_000) };
  const thresholdRaw = record(raw.threshold);
  const thresholdKind = oneOf(thresholdRaw.kind, [
    "SIMPLE_MAJORITY", "SUPERMAJORITY", "UNANIMOUS", "NAMED_ROLE_CONCURRENCE", "BLOCKED_CONFIG",
  ] as const, "threshold.kind");
  let threshold: IcPolicySnapshot["threshold"];
  if (thresholdKind === "SIMPLE_MAJORITY" || thresholdKind === "UNANIMOUS") threshold = { kind: thresholdKind };
  else if (thresholdKind === "SUPERMAJORITY") threshold = { kind: thresholdKind, basisPoints: integer(thresholdRaw.basisPoints, "threshold.basisPoints", 1, 10_000) };
  else if (thresholdKind === "BLOCKED_CONFIG") {
    const reason = String(thresholdRaw.reason ?? "").trim();
    if (!reason) throw new PeDomainError("IC_BLOCKED_CONFIG", "BLOCKED_CONFIG threshold requires a reason");
    threshold = { kind: thresholdKind, reason };
  } else {
    const memberRole = String(thresholdRaw.memberRole ?? "").trim();
    if (!memberRole) throw new PeDomainError("IC_BLOCKED_CONFIG", "named-role concurrence requires memberRole");
    const base = oneOf(thresholdRaw.base, ["SIMPLE_MAJORITY", "SUPERMAJORITY"] as const, "threshold.base");
    threshold = {
      kind: thresholdKind,
      memberRole,
      base,
      ...(base === "SUPERMAJORITY" ? { basisPoints: integer(thresholdRaw.basisPoints, "threshold.basisPoints", 1, 10_000) } : {}),
    };
  }
  const allowedPrimaryRunValidities = array(raw.allowedPrimaryRunValidities).map((item) => {
    if (typeof item !== "string" || !VALIDITIES.has(item)) throw new PeDomainError("IC_BLOCKED_CONFIG", "IC policy contains an unsupported UnderwritingRun validity");
    return item as "VALID" | "INVALID" | "INCOMPLETE" | "NON_CONVERGENT";
  });
  if (allowedPrimaryRunValidities.length === 0 || new Set(allowedPrimaryRunValidities).size !== allowedPrimaryRunValidities.length) {
    throw new PeDomainError("IC_BLOCKED_CONFIG", "IC policy must list a non-empty unique allowedPrimaryRunValidities set");
  }
  return {
    schemaVersion: "pe-ic-policy.v1",
    quorum,
    threshold,
    abstentionsCountForQuorum: bool(raw.abstentionsCountForQuorum, "abstentionsCountForQuorum"),
    deferralsCountForQuorum: bool(raw.deferralsCountForQuorum, "deferralsCountForQuorum"),
    abstentionsCountAsNonApprove: bool(raw.abstentionsCountAsNonApprove, "abstentionsCountAsNonApprove"),
    deferralsCountAsNonApprove: bool(raw.deferralsCountAsNonApprove, "deferralsCountAsNonApprove"),
    memoChange: oneOf(raw.memoChange, ["REQUIRE_REVOTE", "REQUIRE_REAFFIRMATION", "RETAIN_IF_NON_MATERIAL"] as const, "memoChange"),
    underwritingRunChange: oneOf(raw.underwritingRunChange, ["REQUIRE_NEW_RECOMMENDATION"] as const, "underwritingRunChange"),
    requiredQuestionWaiverAllowed: bool(raw.requiredQuestionWaiverAllowed, "requiredQuestionWaiverAllowed"),
    conditionWaiverAllowed: bool(raw.conditionWaiverAllowed, "conditionWaiverAllowed"),
    allowedPrimaryRunValidities,
  };
}

function canonicalActor(ctx: PeMutationContext): string {
  const employeeId = ctx.auth.employeeId;
  if (!employeeId || !UUID.test(employeeId)) {
    throw new PeDomainError("IC_CANONICAL_EMPLOYEE_REQUIRED", "IC mutations require an authenticated canonical employee");
  }
  return employeeId;
}

function actorBoundContext(ctx: PeMutationContext): PeMutationContext {
  const actor = canonicalActor(ctx);
  return { ...ctx, provenance: { ...ctx.provenance, createdBy: actor } };
}

function expectedVersion(actual: number, expected: number, label: string): void {
  if (!Number.isInteger(expected) || expected < 1 || actual !== expected) {
    throw new PeDomainError("IC_STALE_PRECONDITION", `${label} changed since it was read`, { expectedVersion: expected, actualVersion: actual });
  }
}

function assertIdempotencyKey(value: string): void {
  if (!value.trim() || value.length > 240) throw new PeDomainError("IC_INVALID_INPUT", "idempotencyKey must contain 1 to 240 characters");
}

function sameInstant(left: unknown, right: string | undefined): boolean {
  if (left === null || left === undefined) return right === undefined;
  return right !== undefined && new Date(String(left)).valueOf() === new Date(right).valueOf();
}

function sameOptionalId(actual: unknown, presented: string | undefined): boolean {
  return presented === undefined || actual === presented;
}

async function loadCaseForUpdate(client: PeClient, tenantId: string, caseId: string): Promise<IcCaseRow> {
  assertPeUuid(caseId, "icCaseId");
  const row = (await client.query<IcCaseRow>(
    "SELECT * FROM finnor_os.pe_ic_cases WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    [tenantId, caseId],
  )).rows[0];
  if (!row) throw new PeDomainError("IC_CASE_NOT_FOUND", "ICCase was not found in the authenticated tenant");
  return row;
}

async function loadQuestionForUpdate(client: PeClient, tenantId: string, questionId: string): Promise<IcQuestionRow> {
  assertPeUuid(questionId, "questionId");
  const row = (await client.query<IcQuestionRow>(
    "SELECT * FROM finnor_os.pe_ic_questions WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    [tenantId, questionId],
  )).rows[0];
  if (!row) throw new PeDomainError("IC_QUESTION_NOT_FOUND", "IC Question was not found in the authenticated tenant");
  return row;
}

async function loadConditionForUpdate(client: PeClient, tenantId: string, conditionId: string): Promise<IcConditionRow> {
  assertPeUuid(conditionId, "conditionId");
  const row = (await client.query<IcConditionRow>(
    "SELECT * FROM finnor_os.pe_ic_conditions WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    [tenantId, conditionId],
  )).rows[0];
  if (!row) throw new PeDomainError("IC_CONDITION_NOT_FOUND", "IC Condition was not found in the authenticated tenant");
  return row;
}

async function requireMemoDocumentVersionTx(
  client: PeClient,
  process: IcCaseRow,
  documentId: string,
  documentVersionId: string,
): Promise<SqlRow> {
  const row = (await client.query<SqlRow>(
    `SELECT version.*
       FROM finnor_os.document_versions version
      WHERE version.tenant_id=$1 AND version.document_id=$2 AND version.id=$3
        AND EXISTS (
          SELECT 1
            FROM finnor_os.pe_document_links link
           WHERE link.tenant_id=version.tenant_id
             AND link.document_id=version.document_id
             AND link.world_root_type='pe_deal'
             AND link.world_root_id=$4
             AND link.deal_id=$4
             AND link.archived_at IS NULL
        )`,
    [process.tenant_id, documentId, documentVersionId, process.deal_id],
  )).rows[0];
  if (!row) {
    throw new PeDomainError(
      "IC_MEMO_ROOT_MISMATCH",
      "Exact P3 DocumentVersion is missing or its active PE Document link does not belong to the ICCase Deal root",
    );
  }
  return row;
}

async function authority(ctx: PeMutationContext, capability: string, caseId: string, risk: "medium" | "high" = "high"): Promise<AuthorityDecision> {
  canonicalActor(ctx);
  const decision = await evaluateAuthority(ctx.auth, {
    operation: "action",
    capability,
    resource: { type: "pe_ic_case", id: caseId },
    risk,
  });
  if (decision.outcome !== "allowed") {
    throw new PeDomainError("IC_AUTHORITY_DENIED", `Core Authority denied ${capability}`, { authorityDecisionId: decision.id, outcome: decision.outcome, reasonCode: decision.reasonCode });
  }
  return decision;
}

async function policyForCase(client: PeClient, tenantId: string, caseId: string): Promise<{
  id: string;
  version: number;
  hash: string;
  snapshot: IcPolicySnapshot;
}> {
  const row = (await client.query<{ policy_id: string; policy_version: number; policy_hash: string; policy_snapshot: unknown }>(
    `SELECT config.policy_id::text,config.policy_version,config.policy_hash,config.policy_snapshot
       FROM finnor_os.pe_ic_cases process
       JOIN finnor_os.pe_ic_committee_config_versions config ON config.tenant_id=process.tenant_id AND config.id=process.committee_config_version_id
      WHERE process.tenant_id=$1 AND process.id=$2`,
    [tenantId, caseId],
  )).rows[0];
  if (!row) throw new PeDomainError("IC_BLOCKED_CONFIG", "Pinned IC policy was not found");
  return { id: row.policy_id, version: Number(row.policy_version), hash: row.policy_hash, snapshot: parseIcPolicySnapshot(row.policy_snapshot) };
}

async function policyForConfig(client: PeClient, tenantId: string, configId: string): Promise<{
  id: string;
  version: number;
  hash: string;
  snapshot: IcPolicySnapshot;
}> {
  const row = (await client.query<{ policy_id: string; policy_version: number; policy_hash: string; policy_snapshot: unknown }>(
    `SELECT policy_id::text,policy_version,policy_hash,policy_snapshot
       FROM finnor_os.pe_ic_committee_config_versions WHERE tenant_id=$1 AND id=$2`,
    [tenantId, configId],
  )).rows[0];
  if (!row) throw new PeDomainError("IC_BLOCKED_CONFIG", "Pinned IC committee configuration or policy was not found");
  return { id: row.policy_id, version: Number(row.policy_version), hash: row.policy_hash, snapshot: parseIcPolicySnapshot(row.policy_snapshot) };
}

interface IcUnderwritingBasis {
  row: SqlRow;
  checks: Record<string, unknown>[];
  eligible: boolean;
  blockers: string[];
}

async function inspectUnderwritingBasisTx(
  client: PeClient,
  tenantId: string,
  investmentCaseId: string,
  runId: string,
  policy: IcPolicySnapshot,
): Promise<IcUnderwritingBasis> {
  const row = (await client.query<SqlRow>(
    `SELECT id::text,tenant_id::text,investment_case_id::text,model_version_id::text,scenario_id::text,
            world_at,computed_at,engine_version,model_semantic_hash,input_hash,result_hash,status,validity,
            failure_code,result->'checks' checks
       FROM finnor_os.underwriting_runs
      WHERE tenant_id=$1 AND investment_case_id=$2 AND id=$3`,
    [tenantId, investmentCaseId, runId],
  )).rows[0];
  if (!row) throw new PeDomainError("IC_RUN_NOT_FOUND", "Exact P4 UnderwritingRun was not found for the P1 InvestmentCase");
  const checks = Array.isArray(row.checks) ? row.checks.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
  if (!String(row.result_hash ?? "").match(/^sha256:[0-9a-f]{64}$/)
    || !String(row.model_semantic_hash ?? "").match(/^sha256:[0-9a-f]{64}$/)
    || !String(row.input_hash ?? "").match(/^sha256:[0-9a-f]{64}$/)
    || !row.world_at || !row.model_version_id || !row.computed_at) {
    throw new PeDomainError("IC_CORRUPT_TRUTH", "P4 UnderwritingRun is missing required immutable identity or hash proof");
  }
  const blockers: string[] = [];
  if (row.status !== "SUCCEEDED") blockers.push(`UNDERWRITING_STATUS:${String(row.status)}`);
  if (!policy.allowedPrimaryRunValidities.includes(row.validity as "VALID" | "INVALID" | "INCOMPLETE" | "NON_CONVERGENT")) {
    blockers.push(`UNDERWRITING_VALIDITY:${String(row.validity)}`);
  }
  if (row.status === "SUCCEEDED" && row.validity === "VALID" && checks.some((check) => check.severity === "error" && check.passed !== true)) {
    throw new PeDomainError("IC_CORRUPT_TRUTH", "P4 Run claims VALID while a required error check failed");
  }
  return { row, checks, eligible: blockers.length === 0, blockers };
}

async function requireEligibleUnderwritingBasisTx(
  client: PeClient,
  tenantId: string,
  investmentCaseId: string,
  runId: string,
  policy: IcPolicySnapshot,
): Promise<IcUnderwritingBasis> {
  const basis = await inspectUnderwritingBasisTx(client, tenantId, investmentCaseId, runId, policy);
  if (!basis.eligible) {
    throw new PeDomainError("IC_RUN_POLICY_BLOCKED", "Pinned IC policy does not allow this P4 UnderwritingRun validity", {
      runId,
      status: basis.row.status,
      validity: basis.row.validity,
      blockers: basis.blockers,
    });
  }
  return basis;
}

async function requireVotingBasisTx(
  client: PeClient,
  process: IcCaseRow,
  expected?: { recommendationId: string; memoId: string; underwritingRunId: string },
): Promise<void> {
  if (!process.current_memo_id || !process.current_recommendation_id || !process.primary_underwriting_run_id) {
    throw new PeDomainError("IC_PREREQUISITE_MISSING", "Voting requires an exact Memo, Recommendation and primary UnderwritingRun");
  }
  if (expected && (expected.recommendationId !== process.current_recommendation_id
    || expected.memoId !== process.current_memo_id
    || expected.underwritingRunId !== process.primary_underwriting_run_id)) {
    throw new PeDomainError("IC_BASIS_MISMATCH", "Presented voting basis no longer matches the selected exact Memo, Recommendation and UnderwritingRun");
  }
  const recommendation = (await client.query<{ memo_id: string; underwriting_run_id: string }>(
    `SELECT memo_id::text,underwriting_run_id::text FROM finnor_os.pe_ic_recommendations
      WHERE tenant_id=$1 AND ic_case_id=$2 AND id=$3`,
    [process.tenant_id, process.id, process.current_recommendation_id],
  )).rows[0];
  if (!recommendation || recommendation.memo_id !== process.current_memo_id
    || recommendation.underwriting_run_id !== process.primary_underwriting_run_id) {
    throw new PeDomainError("IC_BASIS_MISMATCH", "Selected Recommendation does not pin the selected exact Memo and UnderwritingRun");
  }
  const unresolved = (await client.query<{ id: string }>(
    `SELECT id::text FROM finnor_os.pe_ic_questions
      WHERE tenant_id=$1 AND ic_case_id=$2 AND required_before_vote
        AND state NOT IN ('RESOLVED','WAIVED','SUPERSEDED')
      ORDER BY id`,
    [process.tenant_id, process.id],
  )).rows.map((row) => row.id);
  if (unresolved.length > 0) {
    throw new PeDomainError("IC_REQUIRED_QUESTIONS_OPEN", "Required IC Questions block voting", { questionIds: unresolved });
  }
  const policy = await policyForCase(client, process.tenant_id, process.id);
  await requireEligibleUnderwritingBasisTx(
    client,
    process.tenant_id,
    process.investment_case_id,
    process.primary_underwriting_run_id,
    policy.snapshot,
  );
}

async function governanceReceiptTx(db: Db, input: {
  tenantId: string;
  actorId: string;
  objective: string;
  evidence: Array<{ source: string; ref: string; timestamp: string }>;
  policy: { id: string; version: number } | null;
  proposedAction: Record<string, unknown>;
  actualResult: Record<string, unknown>;
  correlationId?: string;
}): Promise<string> {
  const opened = await openReceiptTx(db, {
    tenantId: input.tenantId,
    objective: input.objective,
    evidence: input.evidence,
    policyApplied: input.policy,
    riskTier: "high",
    proposedAction: input.proposedAction,
    approval: { required: false, approvedBy: input.actorId, at: new Date().toISOString() },
    expectedResult: input.actualResult,
    correlationId: input.correlationId,
  });
  await finalizeReceiptTx(db, input.tenantId, opened.receiptId, { actualResult: input.actualResult, evidence: input.evidence });
  return opened.receiptId;
}

function mutation(row: SqlRow, changed = true, idempotent = false): PeMutationResult {
  return { row: shapePeRow(row), changed, idempotent };
}

export async function createIcCommitteeConfiguration(ctx: PeMutationContext, input: {
  id?: string;
  committeeOrgUnitId: string;
  policyRevisionId: string;
  members: Array<{
    employeeId: string;
    memberRole: string;
    votingEligible?: boolean;
    chair?: boolean;
    effectiveFrom: string;
    effectiveUntil?: string;
  }>;
  idempotencyKey: string;
}): Promise<{ config: Record<string, unknown>; members: Record<string, unknown>[]; idempotent: boolean }> {
  const bound = actorBoundContext(ctx);
  const actorId = canonicalActor(bound);
  assertPeUuid(input.committeeOrgUnitId, "committeeOrgUnitId");
  assertPeUuid(input.policyRevisionId, "policyRevisionId");
  assertIdempotencyKey(input.idempotencyKey);
  if (input.members.length < 1 || input.members.length > 50) throw new PeDomainError("IC_MEMBER_LIMIT", "Committee configuration requires 1 to 50 members");
  if (new Set(input.members.map((member) => member.employeeId)).size !== input.members.length) throw new PeDomainError("IC_DUPLICATE_MEMBER", "Committee configuration contains a duplicate canonical employee");
  for (const member of input.members) {
    assertPeUuid(member.employeeId, "member.employeeId");
    assertPeText(member.memberRole, "member.memberRole");
    if (!Number.isFinite(Date.parse(member.effectiveFrom)) || (member.effectiveUntil && !Number.isFinite(Date.parse(member.effectiveUntil)))) {
      throw new PeDomainError("IC_INVALID_INPUT", "Committee member effective dates must be ISO timestamps");
    }
  }
  const configId = input.id ?? randomUUID();
  assertPeUuid(configId, "configId");
  const authorityDecision = await authority(bound, "ic:configure_committee", input.committeeOrgUnitId);
  return peTransaction(bound, async (_db, client) => {
    const existing = (await client.query<SqlRow>(
      "SELECT * FROM finnor_os.pe_ic_committee_config_versions WHERE tenant_id=$1 AND idempotency_key=$2",
      [bound.auth.tenantId, input.idempotencyKey],
    )).rows[0];
    if (existing) {
      if (existing.committee_org_unit_id !== input.committeeOrgUnitId || existing.policy_revision_id !== input.policyRevisionId) {
        throw new PeDomainError("IC_IDEMPOTENCY_CONFLICT", "Committee configuration idempotency key has different immutable input");
      }
      const memberRows = (await client.query<SqlRow>(
        "SELECT * FROM finnor_os.pe_ic_committee_membership_versions WHERE tenant_id=$1 AND committee_config_version_id=$2 ORDER BY employee_id",
        [bound.auth.tenantId, existing.id],
      )).rows;
      const presented = [...input.members].sort((left, right) => left.employeeId.localeCompare(right.employeeId));
      const sameMembers = memberRows.length === presented.length && memberRows.every((member, index) => {
        const candidate = presented[index]!;
        return member.employee_id === candidate.employeeId
          && member.member_role === candidate.memberRole.trim()
          && Boolean(member.voting_eligible) === (candidate.votingEligible ?? true)
          && Boolean(member.chair) === (candidate.chair ?? false)
          && sameInstant(member.effective_from, candidate.effectiveFrom)
          && sameInstant(member.effective_until, candidate.effectiveUntil);
      });
      if (!sameMembers) throw new PeDomainError("IC_IDEMPOTENCY_CONFLICT", "Committee configuration idempotency key has a different immutable membership snapshot");
      return { config: shapePeRow(existing), members: memberRows.map(shapePeRow), idempotent: true };
    }
    await client.query("SELECT id FROM finnor_os.org_units WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [bound.auth.tenantId, input.committeeOrgUnitId]);
    const revision = (await client.query<{ tenant_id: string; policy_id: string; action_type: string; version: number; policy: unknown }>(
      "SELECT tenant_id::text,policy_id::text,action_type,version,policy FROM finnor_os.domain_policy_revisions WHERE id=$1",
      [input.policyRevisionId],
    )).rows[0];
    if (!revision || revision.tenant_id !== bound.auth.tenantId || revision.action_type !== "private_equity:ic_process") {
      throw new PeDomainError("IC_BLOCKED_CONFIG", "The exact Core IC DomainPolicy revision was not found in this tenant");
    }
    parseIcPolicySnapshot(revision.policy);
    const prior = (await client.query<{ version: number }>(
      "SELECT coalesce(max(config_version),0)::int version FROM finnor_os.pe_ic_committee_config_versions WHERE tenant_id=$1 AND committee_org_unit_id=$2",
      [bound.auth.tenantId, input.committeeOrgUnitId],
    )).rows[0]?.version ?? 0;
    const created = (await client.query<SqlRow>(
      `INSERT INTO finnor_os.pe_ic_committee_config_versions(
         id,tenant_id,committee_org_unit_id,config_version,policy_id,policy_version,policy_revision_id,
         policy_snapshot,policy_hash,created_by,authority_decision_id,idempotency_key,source_system
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,
         'sha256:'||encode(public.digest(convert_to(($8::jsonb)::text,'UTF8'),'sha256'),'hex'),$9,$10,$11,$12)
       RETURNING *`,
      [configId, bound.auth.tenantId, input.committeeOrgUnitId, prior + 1, revision.policy_id, revision.version,
        input.policyRevisionId, JSON.stringify(revision.policy), actorId, authorityDecision.id, input.idempotencyKey, peProvenance(bound).sourceSystem],
    )).rows[0]!;
    const createdMembers: Record<string, unknown>[] = [];
    for (const member of [...input.members].sort((left, right) => left.employeeId.localeCompare(right.employeeId))) {
      const row = (await client.query<SqlRow>(
        `INSERT INTO finnor_os.pe_ic_committee_membership_versions(
          tenant_id,committee_config_version_id,employee_id,member_role,voting_eligible,chair,effective_from,effective_until,created_by
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [bound.auth.tenantId, configId, member.employeeId, member.memberRole.trim(), member.votingEligible ?? true,
          member.chair ?? false, new Date(member.effectiveFrom), member.effectiveUntil ? new Date(member.effectiveUntil) : null, actorId],
      )).rows[0]!;
      createdMembers.push(shapePeRow(row));
    }
    return { config: shapePeRow(created), members: createdMembers, idempotent: false };
  });
}

export async function createIcCase(ctx: PeMutationContext, input: {
  id?: string;
  dealId: string;
  investmentCaseId: string;
  committeeConfigVersionId: string;
  scheduledInternalEventId?: string;
  primaryUnderwritingRunId?: string;
  reconsidersDecisionId?: string;
  workId?: string;
  idempotencyKey: string;
  governance?: GovernanceProof;
}): Promise<PeMutationResult> {
  const bound = actorBoundContext(ctx);
  const actorId = canonicalActor(bound);
  [input.dealId, input.investmentCaseId, input.committeeConfigVersionId].forEach((id) => assertPeUuid(id, "ICCase reference"));
  for (const id of [input.scheduledInternalEventId, input.primaryUnderwritingRunId, input.reconsidersDecisionId, input.workId]) if (id) assertPeUuid(id, "optional ICCase reference");
  assertIdempotencyKey(input.idempotencyKey);
  const id = input.id ?? randomUUID();
  assertPeUuid(id, "icCaseId");
  if (input.governance) assertPeUuid(input.governance.authorityDecisionId, "governance.authorityDecisionId");
  const authorityDecisionId = input.governance?.authorityDecisionId ?? (await authority(bound, "ic:open_case", id)).id;
  const result = await peTransaction(bound, async (db, client) => {
    const existing = (await client.query<SqlRow>(
      "SELECT * FROM finnor_os.pe_ic_cases WHERE tenant_id=$1 AND idempotency_key=$2",
      [bound.auth.tenantId, input.idempotencyKey],
    )).rows[0];
    if (existing) {
      if (existing.deal_id !== input.dealId || existing.investment_case_id !== input.investmentCaseId
        || existing.committee_config_version_id !== input.committeeConfigVersionId
        || existing.scheduled_internal_event_id !== (input.scheduledInternalEventId ?? null)
        || existing.primary_underwriting_run_id !== (input.primaryUnderwritingRunId ?? null)
        || existing.reconsiders_decision_id !== (input.reconsidersDecisionId ?? null)) {
        throw new PeDomainError("IC_IDEMPOTENCY_CONFLICT", "ICCase idempotency key has different immutable input");
      }
      return mutation(existing, false, true);
    }
    const policy = await policyForConfig(client, bound.auth.tenantId, input.committeeConfigVersionId);
    if (input.primaryUnderwritingRunId) {
      await requireEligibleUnderwritingBasisTx(client, bound.auth.tenantId, input.investmentCaseId, input.primaryUnderwritingRunId, policy.snapshot);
    }
    const source = peProvenance(bound);
    const row = (await client.query<SqlRow>(
      `INSERT INTO finnor_os.pe_ic_cases(
        id,tenant_id,deal_id,investment_case_id,committee_config_version_id,scheduled_internal_event_id,
        primary_underwriting_run_id,reconsiders_decision_id,opened_by,opened_authority_decision_id,
        source_system,external_id,idempotency_key,observed_at,created_by
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [id, bound.auth.tenantId, input.dealId, input.investmentCaseId, input.committeeConfigVersionId,
        input.scheduledInternalEventId ?? null, input.primaryUnderwritingRunId ?? null, input.reconsidersDecisionId ?? null,
        actorId, authorityDecisionId, source.sourceSystem, source.externalId, input.idempotencyKey, source.observedAt, source.createdBy],
    )).rows[0]!;
    if (input.workId) {
      await attachWorkEntityTx(db, {
        tenantId: bound.auth.tenantId,
        workId: input.workId,
        entity: { entityType: "pe_ic_case", entityId: id, relationship: "about", source: source.sourceSystem },
      });
    }
    return mutation(row);
  });
  if (!result.idempotent) emitIcMetric(bound, "ic_cases_opened", {
    icCaseId: String(result.row.id), investmentCaseId: input.investmentCaseId,
    entityId: String(result.row.id), state: String(result.row.state), result: "success",
  });
  return result;
}

async function transitionCase(ctx: PeMutationContext, input: {
  icCaseId: string;
  expectedVersion: number;
  targetState: IcCaseState;
}): Promise<PeMutationResult> {
  const bound = actorBoundContext(ctx);
  try {
    return await peTransaction(bound, async (_db, client) => {
      const current = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
      if (current.state === input.targetState) return mutation(current, false, true);
      expectedVersion(Number(current.version), input.expectedVersion, "ICCase");
      if (!IC_CASE_TRANSITIONS[current.state].includes(input.targetState)) {
        throw new PeDomainError("IC_INVALID_TRANSITION", `Invalid ICCase transition ${current.state} -> ${input.targetState}`);
      }
      const closedAt = ["WITHDRAWN", "SUPERSEDED"].includes(input.targetState) ? new Date() : null;
      const row = (await client.query<SqlRow>(
        `UPDATE finnor_os.pe_ic_cases SET state=$3,closed_at=coalesce($4,closed_at),version=version+1,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND id=$2 AND version=$5 RETURNING *`,
        [bound.auth.tenantId, input.icCaseId, input.targetState, closedAt, input.expectedVersion],
      )).rows[0];
      if (!row) throw new PeDomainError("IC_STALE_PRECONDITION", "ICCase changed concurrently");
      return mutation(row);
    });
  } catch (error) {
    emitIcMetric(bound, "ic_case_transition_failures", { icCaseId: input.icCaseId, state: input.targetState, result: "failure" });
    throw error;
  }
}

export const beginIcPreparation = (ctx: PeMutationContext, input: { icCaseId: string; expectedVersion: number }) =>
  transitionCase(ctx, { ...input, targetState: "PREPARING" });
export const markIcReadyForReview = (ctx: PeMutationContext, input: { icCaseId: string; expectedVersion: number }) =>
  transitionCase(ctx, { ...input, targetState: "READY_FOR_REVIEW" });
export const openIcQuestions = (ctx: PeMutationContext, input: { icCaseId: string; expectedVersion: number }) =>
  transitionCase(ctx, { ...input, targetState: "QUESTIONS_OPEN" });
export async function markIcReadyForVote(
  ctx: PeMutationContext,
  input: { icCaseId: string; expectedVersion: number },
): Promise<PeMutationResult> {
  const bound = actorBoundContext(ctx);
  return peTransaction(bound, async (_db, client) => {
    const process = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
    if (process.state === "READY_FOR_VOTE") return mutation(process, false, true);
    expectedVersion(Number(process.version), input.expectedVersion, "ICCase");
    if (!IC_CASE_TRANSITIONS[process.state].includes("READY_FOR_VOTE")) {
      throw new PeDomainError("IC_INVALID_TRANSITION", `Invalid ICCase transition ${process.state} -> READY_FOR_VOTE`);
    }
    await requireVotingBasisTx(client, process);
    const row = (await client.query<SqlRow>(
      `UPDATE finnor_os.pe_ic_cases SET state='READY_FOR_VOTE',version=version+1,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND version=$3 RETURNING *`,
      [bound.auth.tenantId, process.id, input.expectedVersion],
    )).rows[0];
    if (!row) throw new PeDomainError("IC_STALE_PRECONDITION", "ICCase changed concurrently");
    return mutation(row);
  });
}
export const withdrawIcCase = (ctx: PeMutationContext, input: { icCaseId: string; expectedVersion: number }) =>
  transitionCase(ctx, { ...input, targetState: "WITHDRAWN" });

export async function selectIcMemoVersion(ctx: PeMutationContext, input: {
  id?: string;
  icCaseId: string;
  expectedCaseVersion: number;
  artifactRole: "MEMO" | "DECK";
  documentId: string;
  documentVersionId: string;
  underwritingRunId?: string;
  evidenceCutoffAt: string;
  sourceCompleteness: "COMPLETE" | "INCOMPLETE" | "CONFLICTING" | "UNKNOWN";
  changeClassification?: "INITIAL" | "MATERIAL" | "NON_MATERIAL" | "MANUAL_REVIEW_REQUIRED";
  semanticChecks?: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<{ memo: Record<string, unknown>; case: Record<string, unknown>; idempotent: boolean }> {
  const bound = actorBoundContext(ctx);
  const actorId = canonicalActor(bound);
  [input.icCaseId, input.documentId, input.documentVersionId].forEach((id) => assertPeUuid(id, "IC Memo reference"));
  if (input.underwritingRunId) assertPeUuid(input.underwritingRunId, "underwritingRunId");
  if (!Number.isFinite(Date.parse(input.evidenceCutoffAt))) throw new PeDomainError("IC_INVALID_INPUT", "evidenceCutoffAt must be an ISO timestamp");
  assertIdempotencyKey(input.idempotencyKey);
  const id = input.id ?? randomUUID();
  return peTransaction(bound, async (_db, client) => {
    const existing = (await client.query<SqlRow>("SELECT * FROM finnor_os.pe_ic_memos WHERE tenant_id=$1 AND idempotency_key=$2", [bound.auth.tenantId, input.idempotencyKey])).rows[0];
    if (existing) {
      if (existing.ic_case_id !== input.icCaseId || existing.document_id !== input.documentId
        || existing.document_version_id !== input.documentVersionId || existing.artifact_role !== input.artifactRole
        || !sameOptionalId(existing.underwriting_run_id, input.underwritingRunId)
        || !sameInstant(existing.evidence_cutoff_at, input.evidenceCutoffAt)
        || existing.source_completeness !== input.sourceCompleteness
        || (input.changeClassification !== undefined && existing.change_classification !== input.changeClassification)
        || (input.semanticChecks !== undefined && icSemanticHash(existing.semantic_checks) !== icSemanticHash(input.semanticChecks))) {
        throw new PeDomainError("IC_IDEMPOTENCY_CONFLICT", "IC Memo idempotency key has different immutable input");
      }
      const process = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
      return { memo: shapePeRow(existing), case: shapePeRow(process), idempotent: true };
    }
    const process = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
    expectedVersion(Number(process.version), input.expectedCaseVersion, "ICCase");
    await requireMemoDocumentVersionTx(client, process, input.documentId, input.documentVersionId);
    const prior = (await client.query<{ id: string; revision: number }>(
      `SELECT id::text,revision FROM finnor_os.pe_ic_memos WHERE tenant_id=$1 AND ic_case_id=$2 AND artifact_role=$3 ORDER BY revision DESC LIMIT 1`,
      [bound.auth.tenantId, input.icCaseId, input.artifactRole],
    )).rows[0];
    const now = new Date();
    const created = (await client.query<SqlRow>(
      `INSERT INTO finnor_os.pe_ic_memos(
        id,tenant_id,deal_id,investment_case_id,ic_case_id,artifact_role,document_id,document_version_id,
        underwriting_run_id,evidence_cutoff_at,source_completeness,change_classification,semantic_checks,
        revision,supersedes_memo_id,idempotency_key,created_by,created_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18) RETURNING *`,
      [id, bound.auth.tenantId, process.deal_id, process.investment_case_id, process.id, input.artifactRole,
        input.documentId, input.documentVersionId, input.underwritingRunId ?? process.primary_underwriting_run_id,
        new Date(input.evidenceCutoffAt), input.sourceCompleteness,
        input.changeClassification ?? (prior ? "MANUAL_REVIEW_REQUIRED" : "INITIAL"), JSON.stringify(input.semanticChecks ?? {}),
        (prior?.revision ?? 0) + 1, prior?.id ?? null, input.idempotencyKey, actorId, now],
    )).rows[0]!;
    const basisField = input.artifactRole === "MEMO" ? "current_memo_id" : "current_deck_id";
    const invalidate = ["VOTING", "CONDITIONS_PENDING"].includes(process.state)
      || (input.artifactRole === "MEMO" && process.state === "READY_FOR_VOTE");
    const updated = (await client.query<SqlRow>(
      `UPDATE finnor_os.pe_ic_cases SET ${basisField}=$3,
         current_recommendation_id=CASE WHEN $4 THEN NULL ELSE current_recommendation_id END,
         state=CASE WHEN $4 THEN 'READY_FOR_REVIEW' ELSE state END,
         version=version+1,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2 AND version=$5 RETURNING *`,
      [bound.auth.tenantId, process.id, id, invalidate, process.version],
    )).rows[0];
    if (!updated) throw new PeDomainError("IC_STALE_PRECONDITION", "ICCase changed while selecting Memo version");
    return { memo: shapePeRow(created), case: shapePeRow(updated), idempotent: false };
  });
}

export async function selectPrimaryIcUnderwritingRun(ctx: PeMutationContext, input: {
  icCaseId: string;
  expectedCaseVersion: number;
  underwritingRunId: string;
}): Promise<PeMutationResult> {
  const bound = actorBoundContext(ctx);
  assertPeUuid(input.underwritingRunId, "underwritingRunId");
  return peTransaction(bound, async (_db, client) => {
    const process = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
    if (process.primary_underwriting_run_id === input.underwritingRunId) return mutation(process, false, true);
    expectedVersion(Number(process.version), input.expectedCaseVersion, "ICCase");
    const policy = await policyForCase(client, bound.auth.tenantId, process.id);
    await requireEligibleUnderwritingBasisTx(client, bound.auth.tenantId, process.investment_case_id, input.underwritingRunId, policy.snapshot);
    const invalidate = ["READY_FOR_VOTE", "VOTING", "CONDITIONS_PENDING"].includes(process.state);
    const updated = (await client.query<SqlRow>(
      `UPDATE finnor_os.pe_ic_cases SET primary_underwriting_run_id=$3,current_recommendation_id=NULL,
         state=CASE WHEN $4 THEN 'READY_FOR_REVIEW' ELSE state END,version=version+1,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2 AND version=$5 RETURNING *`,
      [bound.auth.tenantId, input.icCaseId, input.underwritingRunId, invalidate, process.version],
    )).rows[0];
    if (!updated) throw new PeDomainError("IC_STALE_PRECONDITION", "ICCase changed while selecting UnderwritingRun");
    return mutation(updated);
  });
}

export async function createIcQuestion(ctx: PeMutationContext, input: {
  id?: string;
  icCaseId: string;
  expectedCaseVersion: number;
  question: string;
  priority?: "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
  requiredBeforeVote?: boolean;
  requiredBeforeDecision?: boolean;
  workId?: string;
  idempotencyKey: string;
}): Promise<{ question: Record<string, unknown>; case: Record<string, unknown>; idempotent: boolean }> {
  const bound = actorBoundContext(ctx);
  const actorId = canonicalActor(bound);
  assertPeText(input.question, "IC Question");
  if (input.question.length > 10_000) throw new PeDomainError("IC_INVALID_INPUT", "IC Question exceeds 10,000 characters");
  if (input.workId) assertPeUuid(input.workId, "workId");
  assertIdempotencyKey(input.idempotencyKey);
  const id = input.id ?? randomUUID();
  const result = await peTransaction(bound, async (db, client) => {
    const existing = (await client.query<SqlRow>("SELECT * FROM finnor_os.pe_ic_questions WHERE tenant_id=$1 AND idempotency_key=$2", [bound.auth.tenantId, input.idempotencyKey])).rows[0];
    if (existing) {
      if (existing.ic_case_id !== input.icCaseId || existing.question !== input.question.trim()
        || existing.priority !== (input.priority ?? "NORMAL")
        || Boolean(existing.required_before_vote) !== (input.requiredBeforeVote ?? false)
        || Boolean(existing.required_before_decision) !== (input.requiredBeforeDecision ?? false)
        || existing.work_id !== (input.workId ?? null)) {
        throw new PeDomainError("IC_IDEMPOTENCY_CONFLICT", "IC Question idempotency key has different immutable input");
      }
      const process = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
      return { question: shapePeRow(existing), case: shapePeRow(process), idempotent: true };
    }
    const process = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
    expectedVersion(Number(process.version), input.expectedCaseVersion, "ICCase");
    if (!["PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN"].includes(process.state)) {
      throw new PeDomainError("IC_INVALID_TRANSITION", `New Questions require PREPARING, READY_FOR_REVIEW or QUESTIONS_OPEN, found ${process.state}`);
    }
    const created = (await client.query<SqlRow>(
      `INSERT INTO finnor_os.pe_ic_questions(
        id,tenant_id,deal_id,investment_case_id,ic_case_id,question,priority,required_before_vote,
        required_before_decision,work_id,raised_by,idempotency_key
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [id, bound.auth.tenantId, process.deal_id, process.investment_case_id, process.id, input.question.trim(),
        input.priority ?? "NORMAL", input.requiredBeforeVote ?? false, input.requiredBeforeDecision ?? false,
        input.workId ?? null, actorId, input.idempotencyKey],
    )).rows[0]!;
    if (input.workId) {
      await attachWorkEntityTx(db, {
        tenantId: bound.auth.tenantId,
        workId: input.workId,
        entity: { entityType: "pe_ic_question", entityId: id, relationship: "about", source: peProvenance(bound).sourceSystem },
      });
    }
    const refreshedCase = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
    return { question: shapePeRow(created), case: shapePeRow(refreshedCase), idempotent: false };
  });
  if (!result.idempotent) {
    emitIcMetric(bound, "ic_questions_open", { icCaseId: input.icCaseId, entityId: String(result.question.id), state: "OPEN", result: "success" });
    if (input.requiredBeforeVote || input.requiredBeforeDecision) {
      emitIcMetric(bound, "ic_required_questions_blocking", { icCaseId: input.icCaseId, entityId: String(result.question.id), state: "OPEN", result: "blocked" });
    }
  }
  return result;
}

function sourceColumns(source: IcSourceRef): {
  sourceKind: IcSourceKind;
  evidenceVersionId: string | null;
  documentId: string | null;
  documentVersionId: string | null;
  anchorId: string | null;
  anchorHash: string | null;
  underwritingRunId: string | null;
  worldEntityType: string | null;
  worldEntityId: string | null;
  questionId: string | null;
  riskId: string | null;
  conditionId: string | null;
} {
  const base = {
    evidenceVersionId: null, documentId: null, documentVersionId: null, anchorId: null, anchorHash: null,
    underwritingRunId: null, worldEntityType: null, worldEntityId: null, questionId: null, riskId: null, conditionId: null,
  };
  switch (source.kind) {
    case "EVIDENCE_VERSION": assertPeUuid(source.evidenceVersionId, "evidenceVersionId"); return { ...base, sourceKind: source.kind, evidenceVersionId: source.evidenceVersionId };
    case "ARTIFACT_ANCHOR":
      assertPeUuid(source.documentId, "documentId"); assertPeUuid(source.documentVersionId, "documentVersionId");
      assertPeText(source.anchorId, "anchorId");
      if (!/^[0-9a-f]{64}$/.test(source.anchorHash)) throw new PeDomainError("IC_INVALID_REFERENCE", "anchorHash must be a lowercase SHA-256 digest");
      return { ...base, sourceKind: source.kind, documentId: source.documentId, documentVersionId: source.documentVersionId, anchorId: source.anchorId, anchorHash: source.anchorHash };
    case "UNDERWRITING_RUN": assertPeUuid(source.underwritingRunId, "underwritingRunId"); return { ...base, sourceKind: source.kind, underwritingRunId: source.underwritingRunId };
    case "P1_WORLD": assertPeUuid(source.entityId, "worldEntityId"); return { ...base, sourceKind: source.kind, worldEntityType: source.entityType, worldEntityId: source.entityId };
    case "IC_QUESTION": assertPeUuid(source.questionId, "questionId"); return { ...base, sourceKind: source.kind, questionId: source.questionId };
    case "PE_RISK": assertPeUuid(source.riskId, "riskId"); return { ...base, sourceKind: source.kind, riskId: source.riskId };
    case "IC_CONDITION": assertPeUuid(source.conditionId, "conditionId"); return { ...base, sourceKind: source.kind, conditionId: source.conditionId };
  }
}

async function insertSourceLinkTx(client: PeClient, params: {
  ctx: PeMutationContext;
  process: IcCaseRow;
  ownerKind: "QUESTION" | "RECOMMENDATION" | "DISSENT" | "CONDITION";
  ownerId: string;
  input: IcSourceLinkInput;
}): Promise<{ row: SqlRow; inserted: boolean }> {
  assertIdempotencyKey(params.input.idempotencyKey);
  const existing = (await client.query<SqlRow>("SELECT * FROM finnor_os.pe_ic_source_links WHERE tenant_id=$1 AND idempotency_key=$2", [params.ctx.auth.tenantId, params.input.idempotencyKey])).rows[0];
  if (existing) {
    const source = sourceColumns(params.input.source);
    const exact = existing.owner_kind === params.ownerKind && existing.owner_id === params.ownerId
      && existing.source_kind === source.sourceKind
      && existing.evidence_version_id === source.evidenceVersionId
      && existing.document_id === source.documentId
      && existing.document_version_id === source.documentVersionId
      && existing.anchor_id === source.anchorId
      && existing.anchor_hash === source.anchorHash
      && existing.underwriting_run_id === source.underwritingRunId
      && existing.world_entity_type === source.worldEntityType
      && existing.world_entity_id === source.worldEntityId
      && existing.question_id === source.questionId
      && existing.pe_risk_id === source.riskId
      && existing.condition_id === source.conditionId
      && existing.relationship === params.input.relationship
      && existing.truth_status === (params.input.truthStatus ?? "ATTACHED");
    if (!exact) throw new PeDomainError("IC_IDEMPOTENCY_CONFLICT", "IC source-link idempotency key has different immutable input");
    return { row: existing, inserted: false };
  }
  const source = sourceColumns(params.input.source);
  const actorId = canonicalActor(params.ctx);
  const row = (await client.query<SqlRow>(
    `INSERT INTO finnor_os.pe_ic_source_links(
      tenant_id,deal_id,investment_case_id,ic_case_id,owner_kind,owner_id,source_kind,evidence_version_id,
      document_id,document_version_id,anchor_id,anchor_hash,underwriting_run_id,world_entity_type,world_entity_id,
      question_id,pe_risk_id,condition_id,relationship,truth_status,idempotency_key,created_by
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING *`,
    [params.ctx.auth.tenantId, params.process.deal_id, params.process.investment_case_id, params.process.id,
      params.ownerKind, params.ownerId, source.sourceKind, source.evidenceVersionId, source.documentId, source.documentVersionId,
      source.anchorId, source.anchorHash, source.underwritingRunId, source.worldEntityType, source.worldEntityId,
      source.questionId, source.riskId, source.conditionId, params.input.relationship,
      params.input.truthStatus ?? "ATTACHED", params.input.idempotencyKey, actorId],
  )).rows[0]!;
  return { row, inserted: true };
}

export async function attachIcQuestionSource(ctx: PeMutationContext, input: {
  icCaseId: string;
  questionId: string;
  expectedQuestionVersion: number;
  link: IcSourceLinkInput;
}): Promise<{ link: Record<string, unknown>; question: Record<string, unknown>; case: Record<string, unknown>; idempotent: boolean }> {
  const bound = actorBoundContext(ctx);
  return peTransaction(bound, async (_db, client) => {
    const existing = (await client.query<SqlRow>("SELECT * FROM finnor_os.pe_ic_source_links WHERE tenant_id=$1 AND idempotency_key=$2", [bound.auth.tenantId, input.link.idempotencyKey])).rows[0];
    if (existing) {
      if (existing.owner_kind !== "QUESTION" || existing.owner_id !== input.questionId) throw new PeDomainError("IC_IDEMPOTENCY_CONFLICT", "IC source-link retry targets a different Question");
      const question = await loadQuestionForUpdate(client, bound.auth.tenantId, input.questionId);
      const process = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
      if (question.ic_case_id !== process.id || existing.ic_case_id !== process.id) {
        throw new PeDomainError("IC_IDEMPOTENCY_CONFLICT", "IC source-link retry targets a different ICCase");
      }
      await insertSourceLinkTx(client, { ctx: bound, process, ownerKind: "QUESTION", ownerId: question.id, input: input.link });
      return { link: shapePeRow(existing), question: shapePeRow(question), case: shapePeRow(process), idempotent: true };
    }
    const process = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
    const question = await loadQuestionForUpdate(client, bound.auth.tenantId, input.questionId);
    if (question.ic_case_id !== process.id) throw new PeDomainError("IC_ROOT_MISMATCH", "Question does not belong to the exact ICCase");
    if (!(["OPEN", "ANSWERED"] as IcQuestionState[]).includes(question.state)) {
      throw new PeDomainError("IC_QUESTION_FINAL", "Evidence cannot be appended after an IC Question is resolved, waived or superseded");
    }
    expectedVersion(Number(question.version), input.expectedQuestionVersion, "IC Question");
    const linked = await insertSourceLinkTx(client, { ctx: bound, process, ownerKind: "QUESTION", ownerId: question.id, input: input.link });
    const refreshedQuestion = await loadQuestionForUpdate(client, bound.auth.tenantId, question.id);
    const refreshedCase = await loadCaseForUpdate(client, bound.auth.tenantId, process.id);
    return { link: shapePeRow(linked.row), question: shapePeRow(refreshedQuestion), case: shapePeRow(refreshedCase), idempotent: !linked.inserted };
  });
}

export async function answerIcQuestion(ctx: PeMutationContext, input: {
  icCaseId: string;
  questionId: string;
  expectedQuestionVersion: number;
  answer: string;
}): Promise<PeMutationResult> {
  const bound = actorBoundContext(ctx);
  const actorId = canonicalActor(bound);
  assertPeText(input.answer, "IC Question answer");
  if (input.answer.length > 20_000) throw new PeDomainError("IC_INVALID_INPUT", "IC Question answer exceeds 20,000 characters");
  return peTransaction(bound, async (_db, client) => {
    await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
    const question = await loadQuestionForUpdate(client, bound.auth.tenantId, input.questionId);
    if (question.ic_case_id !== input.icCaseId) throw new PeDomainError("IC_ROOT_MISMATCH", "Question does not belong to the exact ICCase");
    if (question.state === "ANSWERED" && question.answer === input.answer.trim()) return mutation(question, false, true);
    expectedVersion(Number(question.version), input.expectedQuestionVersion, "IC Question");
    if (!IC_QUESTION_TRANSITIONS[question.state].includes("ANSWERED")) throw new PeDomainError("IC_INVALID_TRANSITION", `Question cannot be answered from ${question.state}`);
    const row = (await client.query<SqlRow>(
      `UPDATE finnor_os.pe_ic_questions SET state='ANSWERED',answer=$3,answered_by=$4,answered_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2 AND version=$5 RETURNING *`,
      [bound.auth.tenantId, question.id, input.answer.trim(), actorId, input.expectedQuestionVersion],
    )).rows[0];
    if (!row) throw new PeDomainError("IC_STALE_PRECONDITION", "IC Question changed concurrently");
    return mutation(row);
  });
}

export async function resolveIcQuestion(ctx: PeMutationContext, input: {
  icCaseId: string;
  questionId: string;
  expectedQuestionVersion: number;
}): Promise<PeMutationResult> {
  const bound = actorBoundContext(ctx);
  const actorId = canonicalActor(bound);
  return peTransaction(bound, async (_db, client) => {
    await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
    const question = await loadQuestionForUpdate(client, bound.auth.tenantId, input.questionId);
    if (question.ic_case_id !== input.icCaseId) throw new PeDomainError("IC_ROOT_MISMATCH", "Question does not belong to the exact ICCase");
    if (question.state === "RESOLVED") return mutation(question, false, true);
    expectedVersion(Number(question.version), input.expectedQuestionVersion, "IC Question");
    if (!IC_QUESTION_TRANSITIONS[question.state].includes("RESOLVED")) throw new PeDomainError("IC_INVALID_TRANSITION", `Question cannot be resolved from ${question.state}`);
    const row = (await client.query<SqlRow>(
      `UPDATE finnor_os.pe_ic_questions SET state='RESOLVED',resolved_by=$3,resolved_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2 AND version=$4 RETURNING *`,
      [bound.auth.tenantId, question.id, actorId, input.expectedQuestionVersion],
    )).rows[0];
    if (!row) throw new PeDomainError("IC_STALE_PRECONDITION", "IC Question changed concurrently");
    return mutation(row);
  });
}

export async function supersedeIcQuestion(ctx: PeMutationContext, input: {
  icCaseId: string;
  questionId: string;
  expectedQuestionVersion: number;
}): Promise<PeMutationResult> {
  const bound = actorBoundContext(ctx);
  const actorId = canonicalActor(bound);
  return peTransaction(bound, async (_db, client) => {
    await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
    const question = await loadQuestionForUpdate(client, bound.auth.tenantId, input.questionId);
    if (question.ic_case_id !== input.icCaseId) throw new PeDomainError("IC_ROOT_MISMATCH", "Question does not belong to the exact ICCase");
    if (question.state === "SUPERSEDED") return mutation(question, false, true);
    expectedVersion(Number(question.version), input.expectedQuestionVersion, "IC Question");
    if (!IC_QUESTION_TRANSITIONS[question.state].includes("SUPERSEDED")) throw new PeDomainError("IC_INVALID_TRANSITION", `Question cannot be superseded from ${question.state}`);
    const row = (await client.query<SqlRow>(
      `UPDATE finnor_os.pe_ic_questions SET state='SUPERSEDED',resolved_by=$3,version=version+1,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2 AND version=$4 RETURNING *`,
      [bound.auth.tenantId, question.id, actorId, input.expectedQuestionVersion],
    )).rows[0];
    if (!row) throw new PeDomainError("IC_STALE_PRECONDITION", "IC Question changed concurrently");
    return mutation(row);
  });
}

export async function waiveIcQuestion(ctx: PeMutationContext, input: {
  icCaseId: string;
  questionId: string;
  expectedQuestionVersion: number;
  reason: string;
  idempotencyKey: string;
}): Promise<{ question: Record<string, unknown>; receiptId: string; idempotent: boolean }> {
  const bound = actorBoundContext(ctx);
  const actorId = canonicalActor(bound);
  assertPeText(input.reason, "Question waiver reason");
  assertIdempotencyKey(input.idempotencyKey);
  const authorityDecision = await authority(bound, "ic:waive_question", input.icCaseId);
  const result = await peTransaction(bound, async (db, client) => {
    await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
    const question = await loadQuestionForUpdate(client, bound.auth.tenantId, input.questionId);
    if (question.ic_case_id !== input.icCaseId) throw new PeDomainError("IC_ROOT_MISMATCH", "Question does not belong to the exact ICCase");
    if (question.state === "WAIVED") {
      const receipt = (await client.query<{ proposed_action: unknown }>(
        "SELECT proposed_action FROM finnor_os.decision_receipts WHERE tenant_id=$1 AND id=$2",
        [bound.auth.tenantId, question.waiver_decision_receipt_id],
      )).rows[0];
      const proposed = record(receipt?.proposed_action);
      if (proposed.idempotencyKey !== input.idempotencyKey || proposed.reason !== input.reason.trim()
        || Number(proposed.expectedVersion) !== input.expectedQuestionVersion) {
        throw new PeDomainError("IC_IDEMPOTENCY_CONFLICT", "Question was waived by a different immutable request");
      }
      return { question: shapePeRow(question), receiptId: String(question.waiver_decision_receipt_id), idempotent: true };
    }
    expectedVersion(Number(question.version), input.expectedQuestionVersion, "IC Question");
    const policy = await policyForCase(client, bound.auth.tenantId, input.icCaseId);
    if (!policy.snapshot.requiredQuestionWaiverAllowed) throw new PeDomainError("IC_POLICY_BLOCKED", "Pinned IC policy does not allow required Question waiver");
    const at = new Date().toISOString();
    const receiptId = await governanceReceiptTx(db, {
      tenantId: bound.auth.tenantId,
      actorId,
      objective: "Waive an exact governed IC Question",
      evidence: [{ source: "pe_ic_question", ref: input.questionId, timestamp: at }, { source: "authority_decision", ref: authorityDecision.id, timestamp: at }],
      policy: { id: policy.id, version: policy.version },
      proposedAction: { action: "waive_ic_question", icCaseId: input.icCaseId, questionId: input.questionId, expectedVersion: input.expectedQuestionVersion, reason: input.reason.trim(), idempotencyKey: input.idempotencyKey },
      actualResult: { questionId: input.questionId, state: "WAIVED" },
      correlationId: bound.auth.correlationId,
    });
    const row = (await client.query<SqlRow>(
      `UPDATE finnor_os.pe_ic_questions SET state='WAIVED',waived_by=$3,waiver_reason=$4,
         waiver_authority_decision_id=$5,waiver_decision_receipt_id=$6,resolved_at=clock_timestamp(),
         version=version+1,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2 AND version=$7 RETURNING *`,
      [bound.auth.tenantId, question.id, actorId, input.reason.trim(), authorityDecision.id, receiptId, input.expectedQuestionVersion],
    )).rows[0];
    if (!row) throw new PeDomainError("IC_STALE_PRECONDITION", "IC Question changed concurrently");
    return { question: shapePeRow(row), receiptId, idempotent: false };
  });
  if (!result.idempotent) emitIcMetric(bound, "ic_question_waivers", {
    icCaseId: input.icCaseId, entityId: input.questionId, state: "WAIVED", result: "success",
  });
  return result;
}

export async function createIcRecommendation(ctx: PeMutationContext, input: {
  id?: string;
  icCaseId: string;
  expectedCaseVersion: number;
  outcome: IcRecommendationOutcome;
  rationale: string;
  memoId?: string;
  underwritingRunId?: string;
  sources?: IcSourceLinkInput[];
  idempotencyKey: string;
}): Promise<{ recommendation: Record<string, unknown>; case: Record<string, unknown>; sourceLinks: Record<string, unknown>[]; idempotent: boolean }> {
  const bound = actorBoundContext(ctx);
  const actorId = canonicalActor(bound);
  assertPeText(input.rationale, "IC Recommendation rationale");
  if (input.rationale.length > 20_000) throw new PeDomainError("IC_INVALID_INPUT", "Recommendation rationale exceeds 20,000 characters");
  assertIdempotencyKey(input.idempotencyKey);
  if ((input.sources?.length ?? 0) > 100) throw new PeDomainError("IC_SOURCE_LIMIT", "Recommendation cannot have more than 100 source links");
  const id = input.id ?? randomUUID();
  const result = await peTransaction(bound, async (_db, client) => {
    const existing = (await client.query<SqlRow>("SELECT * FROM finnor_os.pe_ic_recommendations WHERE tenant_id=$1 AND idempotency_key=$2", [bound.auth.tenantId, input.idempotencyKey])).rows[0];
    if (existing) {
      if (existing.ic_case_id !== input.icCaseId || existing.outcome !== input.outcome
        || existing.rationale !== input.rationale.trim()
        || !sameOptionalId(existing.memo_id, input.memoId)
        || !sameOptionalId(existing.underwriting_run_id, input.underwritingRunId)) {
        throw new PeDomainError("IC_IDEMPOTENCY_CONFLICT", "Recommendation idempotency key has different immutable input");
      }
      const process = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
      const links = (await client.query<SqlRow>("SELECT * FROM finnor_os.pe_ic_source_links WHERE tenant_id=$1 AND owner_kind='RECOMMENDATION' AND owner_id=$2 ORDER BY created_at,id", [bound.auth.tenantId, existing.id])).rows.map(shapePeRow);
      return { recommendation: shapePeRow(existing), case: shapePeRow(process), sourceLinks: links, idempotent: true };
    }
    const process = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
    expectedVersion(Number(process.version), input.expectedCaseVersion, "ICCase");
    if (["DECIDED", "WITHDRAWN", "SUPERSEDED"].includes(process.state)) throw new PeDomainError("IC_CASE_TERMINAL", "A terminal ICCase cannot receive a Recommendation");
    const memoId = input.memoId ?? process.current_memo_id;
    const runId = input.underwritingRunId ?? process.primary_underwriting_run_id;
    if (!memoId || !runId || memoId !== process.current_memo_id || runId !== process.primary_underwriting_run_id) {
      throw new PeDomainError("IC_BASIS_MISMATCH", "Recommendation must pin the selected exact Memo and primary UnderwritingRun");
    }
    const run = (await client.query<{ scenario_id: string | null }>("SELECT scenario_id::text FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND investment_case_id=$2 AND id=$3", [bound.auth.tenantId, process.investment_case_id, runId])).rows[0];
    if (!run) throw new PeDomainError("IC_RUN_NOT_FOUND", "Primary UnderwritingRun was not found for the InvestmentCase");
    const policy = await policyForCase(client, bound.auth.tenantId, process.id);
    await requireEligibleUnderwritingBasisTx(client, bound.auth.tenantId, process.investment_case_id, runId, policy.snapshot);
    const prior = process.current_recommendation_id ? (await client.query<{ id: string; revision: number }>(
      "SELECT id::text,revision FROM finnor_os.pe_ic_recommendations WHERE tenant_id=$1 AND ic_case_id=$2 AND id=$3",
      [bound.auth.tenantId, process.id, process.current_recommendation_id],
    )).rows[0] : undefined;
    const created = (await client.query<SqlRow>(
      `INSERT INTO finnor_os.pe_ic_recommendations(
        id,tenant_id,deal_id,investment_case_id,ic_case_id,revision,supersedes_recommendation_id,
        outcome,memo_id,underwriting_run_id,scenario_id,rationale,authored_by,idempotency_key
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [id, bound.auth.tenantId, process.deal_id, process.investment_case_id, process.id, (prior?.revision ?? 0) + 1,
        prior?.id ?? null, input.outcome, memoId, runId, run.scenario_id, input.rationale.trim(), actorId, input.idempotencyKey],
    )).rows[0]!;
    const invalidates = ["READY_FOR_VOTE", "VOTING", "CONDITIONS_PENDING"].includes(process.state);
    const updatedCase = (await client.query<SqlRow>(
      `UPDATE finnor_os.pe_ic_cases SET current_recommendation_id=$3,
         state=CASE WHEN $4 THEN 'READY_FOR_REVIEW' ELSE state END,version=version+1,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2 AND version=$5 RETURNING *`,
      [bound.auth.tenantId, process.id, id, invalidates, process.version],
    )).rows[0];
    if (!updatedCase) throw new PeDomainError("IC_STALE_PRECONDITION", "ICCase changed while creating Recommendation");
    const links: Record<string, unknown>[] = [];
    let refreshed = updatedCase as IcCaseRow;
    for (const source of input.sources ?? []) {
      const inserted = await insertSourceLinkTx(client, { ctx: bound, process: refreshed, ownerKind: "RECOMMENDATION", ownerId: id, input: source });
      links.push(shapePeRow(inserted.row));
      refreshed = await loadCaseForUpdate(client, bound.auth.tenantId, process.id);
    }
    return { recommendation: shapePeRow(created), case: shapePeRow(refreshed), sourceLinks: links, idempotent: false };
  });
  if (!result.idempotent) emitIcMetric(bound, "ic_recommendation_revisions", {
    icCaseId: input.icCaseId, entityId: String(result.recommendation.id),
    state: String(result.case.state), result: "success",
  });
  return result;
}

export async function openIcVoting(ctx: PeMutationContext, input: {
  icCaseId: string;
  expectedCaseVersion: number;
  recommendationId: string;
  memoId: string;
  underwritingRunId: string;
  idempotencyKey: string;
}): Promise<{ case: Record<string, unknown>; receiptId: string; idempotent: boolean }> {
  const bound = actorBoundContext(ctx);
  const actorId = canonicalActor(bound);
  [input.recommendationId, input.memoId, input.underwritingRunId].forEach((id) => assertPeUuid(id, "voting basis reference"));
  assertIdempotencyKey(input.idempotencyKey);
  const authorityDecision = await authority(bound, "ic:open_voting", input.icCaseId);
  const result = await peTransaction(bound, async (db, client) => {
    const process = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
    if (process.voting_open_idempotency_key === input.idempotencyKey && process.state === "VOTING") {
      if (process.current_recommendation_id !== input.recommendationId
        || process.current_memo_id !== input.memoId
        || process.primary_underwriting_run_id !== input.underwritingRunId
        || Number(process.voting_basis_version) !== input.expectedCaseVersion + 1) {
        throw new PeDomainError("IC_IDEMPOTENCY_CONFLICT", "Voting-open idempotency key has a different immutable basis");
      }
      return { case: shapePeRow(process), receiptId: String(process.voting_open_receipt_id), idempotent: true };
    }
    expectedVersion(Number(process.version), input.expectedCaseVersion, "ICCase");
    if (process.state !== "READY_FOR_VOTE") throw new PeDomainError("IC_INVALID_TRANSITION", `Voting can open only from READY_FOR_VOTE, found ${process.state}`);
    await requireVotingBasisTx(client, process, input);
    const policy = await policyForCase(client, bound.auth.tenantId, process.id);
    const at = new Date();
    const basisVersion = Number(process.version) + 1;
    const actual = {
      icCaseId: process.id,
      state: "VOTING",
      votingBasisVersion: basisVersion,
      recommendationId: input.recommendationId,
      memoId: input.memoId,
      underwritingRunId: input.underwritingRunId,
    };
    const receiptId = await governanceReceiptTx(db, {
      tenantId: bound.auth.tenantId,
      actorId,
      objective: "Open governed IC voting on one exact immutable basis",
      evidence: [
        { source: "pe_ic_recommendation", ref: input.recommendationId, timestamp: at.toISOString() },
        { source: "pe_ic_memo", ref: input.memoId, timestamp: at.toISOString() },
        { source: "underwriting_run", ref: input.underwritingRunId, timestamp: at.toISOString() },
        { source: "authority_decision", ref: authorityDecision.id, timestamp: at.toISOString() },
      ],
      policy: { id: policy.id, version: policy.version },
      proposedAction: {
        action: "open_ic_voting",
        icCaseId: process.id,
        expectedVersion: input.expectedCaseVersion,
        recommendationId: input.recommendationId,
        memoId: input.memoId,
        underwritingRunId: input.underwritingRunId,
        idempotencyKey: input.idempotencyKey,
      },
      actualResult: actual,
      correlationId: bound.auth.correlationId,
    });
    const row = (await client.query<SqlRow>(
      `UPDATE finnor_os.pe_ic_cases SET state='VOTING',voting_basis_version=$3,voting_opened_by=$4,
         voting_open_authority_decision_id=$5,voting_open_receipt_id=$6,voting_open_idempotency_key=$7,
         voting_opened_at=$8,version=version+1,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2 AND version=$9 RETURNING *`,
      [bound.auth.tenantId, process.id, basisVersion, actorId, authorityDecision.id, receiptId,
        input.idempotencyKey, at, input.expectedCaseVersion],
    )).rows[0];
    if (!row) throw new PeDomainError("IC_STALE_PRECONDITION", "ICCase changed while opening voting");
    return { case: shapePeRow(row), receiptId, idempotent: false };
  });
  if (!result.idempotent) emitIcMetric(bound, "ic_voting_sessions", {
    icCaseId: input.icCaseId, entityId: input.recommendationId, state: "VOTING", result: "success",
  });
  return result;
}

export async function recordIcVote(ctx: PeMutationContext, input: {
  id?: string;
  icCaseId: string;
  recommendationId: string;
  memoId: string;
  underwritingRunId: string;
  expectedVotingBasisVersion: number;
  choice: IcVoteChoice;
  rationale?: string;
  idempotencyKey: string;
}): Promise<{ vote: Record<string, unknown>; case: Record<string, unknown>; idempotent: boolean }> {
  const bound = actorBoundContext(ctx);
  const actorId = canonicalActor(bound);
  [input.icCaseId, input.recommendationId, input.memoId, input.underwritingRunId].forEach((id) => assertPeUuid(id, "Vote basis reference"));
  assertIdempotencyKey(input.idempotencyKey);
  if (input.rationale && input.rationale.length > 10_000) throw new PeDomainError("IC_INVALID_INPUT", "Vote rationale exceeds 10,000 characters");
  const id = input.id ?? randomUUID();
  try {
    const result = await peTransaction(bound, async (_db, client) => {
    // Serialize on the ICCase before checking the idempotency key. Without this
    // order, two identical first attempts can both observe no Vote and the loser
    // can be misclassified as a conflicting duplicate after the winner commits.
    const process = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
    const existing = (await client.query<SqlRow>("SELECT * FROM finnor_os.pe_ic_votes WHERE tenant_id=$1 AND idempotency_key=$2", [bound.auth.tenantId, input.idempotencyKey])).rows[0];
    if (existing) {
      if (existing.employee_id !== actorId || existing.ic_case_id !== input.icCaseId || existing.recommendation_id !== input.recommendationId
        || existing.choice !== input.choice || existing.memo_id !== input.memoId || existing.underwriting_run_id !== input.underwritingRunId
        || Number(existing.voting_basis_version) !== input.expectedVotingBasisVersion
        || (existing.rationale ?? null) !== (input.rationale?.trim() || null)) {
        throw new PeDomainError("IC_IDEMPOTENCY_CONFLICT", "Vote idempotency key has different immutable input");
      }
      return { vote: shapePeRow(existing), case: shapePeRow(process), idempotent: true };
    }
    if (process.state !== "VOTING") throw new PeDomainError("IC_VOTING_NOT_OPEN", "Official Vote may be recorded only while voting is open");
    if (Number(process.voting_basis_version) !== input.expectedVotingBasisVersion) {
      throw new PeDomainError("IC_STALE_PRECONDITION", "Voting basis changed since it was presented", { expectedVotingBasisVersion: input.expectedVotingBasisVersion, actualVotingBasisVersion: process.voting_basis_version });
    }
    if (process.current_recommendation_id !== input.recommendationId || process.current_memo_id !== input.memoId || process.primary_underwriting_run_id !== input.underwritingRunId) {
      throw new PeDomainError("IC_BASIS_MISMATCH", "Vote does not pin the exact currently-open Recommendation/Memo/UnderwritingRun basis");
    }
    const recordedAt = new Date();
    const member = (await client.query<{ voting_eligible: boolean; effective_from: Date; effective_until: Date | null }>(
      `SELECT membership.voting_eligible,membership.effective_from,membership.effective_until
         FROM finnor_os.pe_ic_committee_membership_versions membership
        WHERE membership.tenant_id=$1 AND membership.committee_config_version_id=$2 AND membership.employee_id=$3`,
      [bound.auth.tenantId, process.committee_config_version_id, actorId],
    )).rows[0];
    if (!member || !member.voting_eligible || member.effective_from > recordedAt
      || (member.effective_until !== null && member.effective_until <= recordedAt)) {
      throw new PeDomainError("IC_VOTER_INELIGIBLE", "Authenticated employee is not an effective eligible member of the pinned committee configuration");
    }
    const competing = (await client.query<SqlRow>(
      "SELECT * FROM finnor_os.pe_ic_votes WHERE tenant_id=$1 AND recommendation_id=$2 AND employee_id=$3",
      [bound.auth.tenantId, input.recommendationId, actorId],
    )).rows[0];
    if (competing) throw new PeDomainError("IC_VOTE_ALREADY_RECORDED", "Member already has one immutable effective Vote for this Recommendation revision", { voteId: competing.id });
    const row = (await client.query<SqlRow>(
      `INSERT INTO finnor_os.pe_ic_votes(
        id,tenant_id,deal_id,investment_case_id,ic_case_id,recommendation_id,memo_id,underwriting_run_id,
        voting_basis_version,employee_id,choice,rationale,idempotency_key,recorded_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [id, bound.auth.tenantId, process.deal_id, process.investment_case_id, process.id, input.recommendationId,
        input.memoId, input.underwritingRunId, input.expectedVotingBasisVersion, actorId, input.choice,
        input.rationale?.trim() || null, input.idempotencyKey, recordedAt],
    )).rows[0]!;
    const refreshed = await loadCaseForUpdate(client, bound.auth.tenantId, process.id);
    return { vote: shapePeRow(row), case: shapePeRow(refreshed), idempotent: false };
    }, { isolation: "read committed" });
    if (!result.idempotent) emitIcMetric(bound, "ic_votes_recorded", {
      icCaseId: input.icCaseId, entityId: String(result.vote.id), state: "VOTING", result: "success",
    });
    return result;
  } catch (error) {
    if (error instanceof PeDomainError && ["IC_VOTE_ALREADY_RECORDED", "IC_IDEMPOTENCY_CONFLICT"].includes(error.code)) {
      emitIcMetric(bound, "ic_vote_conflicts", { icCaseId: input.icCaseId, result: "failure" });
    }
    if (error instanceof PeDomainError && error.code === "IC_VOTER_INELIGIBLE") {
      emitIcMetric(bound, "ic_ineligible_vote_attempts", { icCaseId: input.icCaseId, result: "failure" });
    }
    throw error;
  }
}

export async function recordIcDissent(ctx: PeMutationContext, input: {
  id?: string;
  icCaseId: string;
  voteId: string;
  rationale: string;
  sources?: IcSourceLinkInput[];
  idempotencyKey: string;
}): Promise<{ dissent: Record<string, unknown>; sourceLinks: Record<string, unknown>[]; case: Record<string, unknown>; idempotent: boolean }> {
  const bound = actorBoundContext(ctx);
  const actorId = canonicalActor(bound);
  assertPeUuid(input.voteId, "voteId");
  assertPeText(input.rationale, "Dissent rationale");
  if (input.rationale.length > 20_000) throw new PeDomainError("IC_INVALID_INPUT", "Dissent rationale exceeds 20,000 characters");
  if ((input.sources?.length ?? 0) > 100) throw new PeDomainError("IC_SOURCE_LIMIT", "Dissent cannot have more than 100 source links");
  assertIdempotencyKey(input.idempotencyKey);
  const id = input.id ?? randomUUID();
  const result = await peTransaction(bound, async (_db, client) => {
    const existing = (await client.query<SqlRow>("SELECT * FROM finnor_os.pe_ic_dissents WHERE tenant_id=$1 AND idempotency_key=$2", [bound.auth.tenantId, input.idempotencyKey])).rows[0];
    if (existing) {
      if (existing.employee_id !== actorId || existing.vote_id !== input.voteId || existing.ic_case_id !== input.icCaseId
        || existing.rationale !== input.rationale.trim()) throw new PeDomainError("IC_IDEMPOTENCY_CONFLICT", "Dissent idempotency key has different immutable input");
      const links = (await client.query<SqlRow>("SELECT * FROM finnor_os.pe_ic_source_links WHERE tenant_id=$1 AND owner_kind='DISSENT' AND owner_id=$2 ORDER BY created_at,id", [bound.auth.tenantId, existing.id])).rows.map(shapePeRow);
      const process = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
      return { dissent: shapePeRow(existing), sourceLinks: links, case: shapePeRow(process), idempotent: true };
    }
    let process = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
    if (process.state !== "VOTING") throw new PeDomainError("IC_VOTING_NOT_OPEN", "Dissent may be recorded only while voting is open");
    const vote = (await client.query<SqlRow>(
      "SELECT * FROM finnor_os.pe_ic_votes WHERE tenant_id=$1 AND ic_case_id=$2 AND id=$3",
      [bound.auth.tenantId, process.id, input.voteId],
    )).rows[0];
    if (!vote || vote.employee_id !== actorId) throw new PeDomainError("IC_DISSENT_VOTE_MISMATCH", "Dissent must attach to the authenticated member's exact Vote");
    const row = (await client.query<SqlRow>(
      `INSERT INTO finnor_os.pe_ic_dissents(
        id,tenant_id,deal_id,investment_case_id,ic_case_id,vote_id,recommendation_id,memo_id,employee_id,rationale,idempotency_key
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id, bound.auth.tenantId, process.deal_id, process.investment_case_id, process.id, vote.id,
        vote.recommendation_id, vote.memo_id, actorId, input.rationale.trim(), input.idempotencyKey],
    )).rows[0]!;
    process = await loadCaseForUpdate(client, bound.auth.tenantId, process.id);
    const links: Record<string, unknown>[] = [];
    for (const source of input.sources ?? []) {
      const linked = await insertSourceLinkTx(client, { ctx: bound, process, ownerKind: "DISSENT", ownerId: id, input: source });
      links.push(shapePeRow(linked.row));
      process = await loadCaseForUpdate(client, bound.auth.tenantId, process.id);
    }
    return { dissent: shapePeRow(row), sourceLinks: links, case: shapePeRow(process), idempotent: false };
  });
  if (!result.idempotent) emitIcMetric(bound, "ic_dissents_recorded", {
    icCaseId: input.icCaseId, entityId: String(result.dissent.id), state: String(result.case.state), result: "success",
  });
  return result;
}

export async function createIcCondition(ctx: PeMutationContext, input: {
  id?: string;
  icCaseId: string;
  expectedCaseVersion: number;
  sourceRecommendationId?: string;
  conditionType: IcConditionType;
  title: string;
  description: string;
  ownerEmployeeId: string;
  workId?: string;
  dueAt?: string;
  required?: boolean;
  evidenceRequired?: boolean;
  idempotencyKey: string;
}): Promise<{ condition: Record<string, unknown>; case: Record<string, unknown>; idempotent: boolean }> {
  const bound = actorBoundContext(ctx);
  const actorId = canonicalActor(bound);
  assertPeText(input.title, "IC Condition title");
  assertPeText(input.description, "IC Condition description");
  if (input.title.length > 500) throw new PeDomainError("IC_INVALID_INPUT", "IC Condition title exceeds 500 characters");
  if (input.description.length > 10_000) throw new PeDomainError("IC_INVALID_INPUT", "IC Condition description exceeds 10,000 characters");
  assertPeUuid(input.ownerEmployeeId, "ownerEmployeeId");
  if (input.workId) assertPeUuid(input.workId, "workId");
  if (input.dueAt && !Number.isFinite(Date.parse(input.dueAt))) throw new PeDomainError("IC_INVALID_INPUT", "Condition dueAt must be an ISO timestamp");
  assertIdempotencyKey(input.idempotencyKey);
  const id = input.id ?? randomUUID();
  const result = await peTransaction(bound, async (db, client) => {
    const existing = (await client.query<SqlRow>("SELECT * FROM finnor_os.pe_ic_conditions WHERE tenant_id=$1 AND idempotency_key=$2", [bound.auth.tenantId, input.idempotencyKey])).rows[0];
    if (existing) {
      if (existing.ic_case_id !== input.icCaseId || existing.title !== input.title.trim()
        || existing.description !== input.description.trim()
        || existing.owner_employee_id !== input.ownerEmployeeId
        || existing.work_id !== (input.workId ?? null)
        || existing.condition_type !== input.conditionType
        || !sameInstant(existing.due_at, input.dueAt)
        || Boolean(existing.required) !== (input.required ?? true)
        || Boolean(existing.evidence_required) !== (input.evidenceRequired ?? true)
        || !sameOptionalId(existing.source_recommendation_id, input.sourceRecommendationId)) {
        throw new PeDomainError("IC_IDEMPOTENCY_CONFLICT", "Condition idempotency key has different immutable input");
      }
      const process = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
      return { condition: shapePeRow(existing), case: shapePeRow(process), idempotent: true };
    }
    const process = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
    expectedVersion(Number(process.version), input.expectedCaseVersion, "ICCase");
    if (["DECIDED", "WITHDRAWN", "SUPERSEDED"].includes(process.state)) throw new PeDomainError("IC_CASE_TERMINAL", "A terminal ICCase cannot receive a new Condition");
    const recommendationId = input.sourceRecommendationId ?? process.current_recommendation_id;
    if (!recommendationId || recommendationId !== process.current_recommendation_id) throw new PeDomainError("IC_BASIS_MISMATCH", "IC Condition must reference the selected Recommendation revision");
    const row = (await client.query<SqlRow>(
      `INSERT INTO finnor_os.pe_ic_conditions(
        id,tenant_id,deal_id,investment_case_id,ic_case_id,source_recommendation_id,condition_type,title,
        description,owner_employee_id,work_id,due_at,required,evidence_required,idempotency_key,created_by
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [id, bound.auth.tenantId, process.deal_id, process.investment_case_id, process.id, recommendationId,
        input.conditionType, input.title.trim(), input.description.trim(), input.ownerEmployeeId, input.workId ?? null,
        input.dueAt ? new Date(input.dueAt) : null, input.required ?? true, input.evidenceRequired ?? true,
        input.idempotencyKey, actorId],
    )).rows[0]!;
    if (input.workId) {
      await attachWorkEntityTx(db, {
        tenantId: bound.auth.tenantId,
        workId: input.workId,
        entity: { entityType: "pe_ic_condition", entityId: id, relationship: "about", source: peProvenance(bound).sourceSystem },
      });
    }
    const refreshed = await loadCaseForUpdate(client, bound.auth.tenantId, process.id);
    return { condition: shapePeRow(row), case: shapePeRow(refreshed), idempotent: false };
  });
  return result;
}

async function transitionCondition(ctx: PeMutationContext, input: {
  icCaseId: string;
  conditionId: string;
  expectedConditionVersion: number;
  targetState: IcConditionState;
  verifiedBy?: string;
}): Promise<PeMutationResult> {
  const bound = actorBoundContext(ctx);
  const result = await peTransaction(bound, async (_db, client) => {
    await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
    const condition = await loadConditionForUpdate(client, bound.auth.tenantId, input.conditionId);
    if (condition.ic_case_id !== input.icCaseId) throw new PeDomainError("IC_ROOT_MISMATCH", "Condition does not belong to the exact ICCase");
    if (condition.state === input.targetState) return mutation(condition, false, true);
    expectedVersion(Number(condition.version), input.expectedConditionVersion, "IC Condition");
    if (!IC_CONDITION_TRANSITIONS[condition.state].includes(input.targetState)) throw new PeDomainError("IC_INVALID_TRANSITION", `Condition cannot transition ${condition.state} -> ${input.targetState}`);
    const row = (await client.query<SqlRow>(
      `UPDATE finnor_os.pe_ic_conditions SET state=$3,verified_by=coalesce($4,verified_by),
         resolved_at=CASE WHEN $3 IN ('SATISFIED','FAILED') THEN clock_timestamp() ELSE resolved_at END,
         version=version+1,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2 AND version=$5 RETURNING *`,
      [bound.auth.tenantId, condition.id, input.targetState, input.verifiedBy ?? null, input.expectedConditionVersion],
    )).rows[0];
    if (!row) throw new PeDomainError("IC_STALE_PRECONDITION", "IC Condition changed concurrently");
    return mutation(row);
  });
  if (!result.idempotent && input.targetState === "ACTIVE") emitIcMetric(bound, "ic_conditions_active", {
    icCaseId: input.icCaseId, entityId: input.conditionId, state: "ACTIVE", result: "success",
  });
  return result;
}

export const activateIcCondition = (ctx: PeMutationContext, input: { icCaseId: string; conditionId: string; expectedConditionVersion: number }) =>
  transitionCondition(ctx, { ...input, targetState: "ACTIVE" });

export const failIcCondition = (ctx: PeMutationContext, input: { icCaseId: string; conditionId: string; expectedConditionVersion: number }) => {
  const actorId = canonicalActor(ctx);
  return transitionCondition(ctx, { ...input, targetState: "FAILED", verifiedBy: actorId });
};

export const supersedeIcCondition = (ctx: PeMutationContext, input: { icCaseId: string; conditionId: string; expectedConditionVersion: number }) => {
  const actorId = canonicalActor(ctx);
  return transitionCondition(ctx, { ...input, targetState: "SUPERSEDED", verifiedBy: actorId });
};

export async function satisfyIcCondition(ctx: PeMutationContext, input: {
  icCaseId: string;
  conditionId: string;
  expectedConditionVersion: number;
  verification: IcSourceLinkInput;
}): Promise<{ condition: Record<string, unknown>; sourceLink: Record<string, unknown>; case: Record<string, unknown>; idempotent: boolean }> {
  const bound = actorBoundContext(ctx);
  const actorId = canonicalActor(bound);
  if (input.verification.relationship !== "VERIFIES") throw new PeDomainError("IC_INVALID_INPUT", "Condition satisfaction source relationship must be VERIFIES");
  return peTransaction(bound, async (_db, client) => {
    let process = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
    const condition = await loadConditionForUpdate(client, bound.auth.tenantId, input.conditionId);
    if (condition.ic_case_id !== process.id) throw new PeDomainError("IC_ROOT_MISMATCH", "Condition does not belong to the exact ICCase");
    if (condition.state === "SATISFIED") {
      const existing = (await client.query<SqlRow>("SELECT * FROM finnor_os.pe_ic_source_links WHERE tenant_id=$1 AND idempotency_key=$2", [bound.auth.tenantId, input.verification.idempotencyKey])).rows[0];
      if (!existing || existing.owner_kind !== "CONDITION" || existing.owner_id !== condition.id || existing.relationship !== "VERIFIES") {
        throw new PeDomainError("IC_IDEMPOTENCY_CONFLICT", "Satisfied Condition does not contain the exact retried verification source");
      }
      await insertSourceLinkTx(client, { ctx: bound, process, ownerKind: "CONDITION", ownerId: condition.id, input: input.verification });
      return { condition: shapePeRow(condition), sourceLink: shapePeRow(existing), case: shapePeRow(process), idempotent: true };
    }
    expectedVersion(Number(condition.version), input.expectedConditionVersion, "IC Condition");
    if (!IC_CONDITION_TRANSITIONS[condition.state].includes("SATISFIED")) throw new PeDomainError("IC_INVALID_TRANSITION", `Condition cannot be satisfied from ${condition.state}`);
    const linked = await insertSourceLinkTx(client, { ctx: bound, process, ownerKind: "CONDITION", ownerId: condition.id, input: input.verification });
    process = await loadCaseForUpdate(client, bound.auth.tenantId, process.id);
    const row = (await client.query<SqlRow>(
      `UPDATE finnor_os.pe_ic_conditions SET state='SATISFIED',verified_by=$3,resolved_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2 AND version=$4 RETURNING *`,
      [bound.auth.tenantId, condition.id, actorId, input.expectedConditionVersion],
    )).rows[0];
    if (!row) throw new PeDomainError("IC_STALE_PRECONDITION", "IC Condition changed concurrently");
    process = await loadCaseForUpdate(client, bound.auth.tenantId, process.id);
    return { condition: shapePeRow(row), sourceLink: shapePeRow(linked.row), case: shapePeRow(process), idempotent: false };
  });
}

export async function waiveIcCondition(ctx: PeMutationContext, input: {
  icCaseId: string;
  conditionId: string;
  expectedConditionVersion: number;
  reason: string;
  idempotencyKey: string;
}): Promise<{ condition: Record<string, unknown>; receiptId: string; idempotent: boolean }> {
  const bound = actorBoundContext(ctx);
  const actorId = canonicalActor(bound);
  assertPeText(input.reason, "Condition waiver reason");
  if (input.reason.length > 10_000) throw new PeDomainError("IC_INVALID_INPUT", "Condition waiver reason exceeds 10,000 characters");
  assertIdempotencyKey(input.idempotencyKey);
  const authorityDecision = await authority(bound, "ic:waive_condition", input.icCaseId);
  const result = await peTransaction(bound, async (db, client) => {
    await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
    const condition = await loadConditionForUpdate(client, bound.auth.tenantId, input.conditionId);
    if (condition.ic_case_id !== input.icCaseId) throw new PeDomainError("IC_ROOT_MISMATCH", "Condition does not belong to the exact ICCase");
    if (condition.state === "WAIVED") {
      const receipt = (await client.query<{ proposed_action: unknown }>(
        "SELECT proposed_action FROM finnor_os.decision_receipts WHERE tenant_id=$1 AND id=$2",
        [bound.auth.tenantId, condition.waiver_decision_receipt_id],
      )).rows[0];
      const proposed = record(receipt?.proposed_action);
      if (proposed.idempotencyKey !== input.idempotencyKey || proposed.reason !== input.reason.trim()
        || Number(proposed.expectedVersion) !== input.expectedConditionVersion) {
        throw new PeDomainError("IC_IDEMPOTENCY_CONFLICT", "Condition was waived by a different immutable request");
      }
      return { condition: shapePeRow(condition), receiptId: String(condition.waiver_decision_receipt_id), idempotent: true };
    }
    expectedVersion(Number(condition.version), input.expectedConditionVersion, "IC Condition");
    const policy = await policyForCase(client, bound.auth.tenantId, input.icCaseId);
    if (!policy.snapshot.conditionWaiverAllowed) throw new PeDomainError("IC_POLICY_BLOCKED", "Pinned IC policy does not allow Condition waiver");
    const at = new Date().toISOString();
    const receiptId = await governanceReceiptTx(db, {
      tenantId: bound.auth.tenantId,
      actorId,
      objective: "Waive an exact governed IC Condition",
      evidence: [{ source: "pe_ic_condition", ref: input.conditionId, timestamp: at }, { source: "authority_decision", ref: authorityDecision.id, timestamp: at }],
      policy: { id: policy.id, version: policy.version },
      proposedAction: { action: "waive_ic_condition", icCaseId: input.icCaseId, conditionId: input.conditionId, expectedVersion: input.expectedConditionVersion, reason: input.reason.trim(), idempotencyKey: input.idempotencyKey },
      actualResult: { conditionId: input.conditionId, state: "WAIVED" },
      correlationId: bound.auth.correlationId,
    });
    const row = (await client.query<SqlRow>(
      `UPDATE finnor_os.pe_ic_conditions SET state='WAIVED',verified_by=$3,waiver_reason=$4,
         waiver_authority_decision_id=$5,waiver_decision_receipt_id=$6,resolved_at=clock_timestamp(),
         version=version+1,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2 AND version=$7 RETURNING *`,
      [bound.auth.tenantId, condition.id, actorId, input.reason.trim(), authorityDecision.id, receiptId, input.expectedConditionVersion],
    )).rows[0];
    if (!row) throw new PeDomainError("IC_STALE_PRECONDITION", "IC Condition changed concurrently");
    return { condition: shapePeRow(row), receiptId, idempotent: false };
  });
  if (!result.idempotent) emitIcMetric(bound, "ic_condition_waivers", {
    icCaseId: input.icCaseId, entityId: input.conditionId, state: "WAIVED", result: "success",
  });
  return result;
}

interface IcProposalMaterial {
  policy: { id: string; version: number; hash: string; snapshot: IcPolicySnapshot };
  aggregation: IcAggregationResult;
  voteSnapshot: Record<string, unknown>[];
  dissentSnapshot: Record<string, unknown>[];
  questionSnapshot: Record<string, unknown>[];
  conditionSnapshot: Record<string, unknown>[];
  proposedDecision: Record<string, unknown>;
}

function isoTimestamp(value: unknown, label: string): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.valueOf())) throw new PeDomainError("IC_CORRUPT_TRUTH", `${label} is not a valid timestamp`);
  return date.toISOString();
}

function proposalIdempotencyKey(kind: "prepare" | "close", value: string): string {
  return `${kind}/${icSemanticHash(value).slice("sha256:".length)}`;
}

function sourceSummaries(rows: SqlRow[], ownerKind: string, ownerId: string): Record<string, unknown>[] {
  return rows
    .filter((row) => row.owner_kind === ownerKind && row.owner_id === ownerId)
    .map((row) => ({
      id: row.id,
      sourceKind: row.source_kind,
      relationship: row.relationship,
      truthStatus: row.truth_status,
    }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

async function buildProposalMaterialTx(client: PeClient, process: IcCaseRow, at: Date): Promise<IcProposalMaterial> {
  if (!process.current_recommendation_id || !process.current_memo_id || !process.primary_underwriting_run_id || !process.voting_basis_version) {
    throw new PeDomainError("IC_PREREQUISITE_MISSING", "Decision proposal requires an exact open voting basis");
  }
  const policy = await policyForCase(client, process.tenant_id, process.id);
  await requireEligibleUnderwritingBasisTx(client, process.tenant_id, process.investment_case_id, process.primary_underwriting_run_id, policy.snapshot);
  const recommendation = (await client.query<SqlRow>(
    `SELECT * FROM finnor_os.pe_ic_recommendations
      WHERE tenant_id=$1 AND ic_case_id=$2 AND id=$3`,
    [process.tenant_id, process.id, process.current_recommendation_id],
  )).rows[0];
  if (!recommendation) throw new PeDomainError("IC_BASIS_MISMATCH", "Selected Recommendation was not found");

  // A node-postgres client executes one query at a time. Keep this exact-snapshot
  // read sequential so concurrent callers never share an already-executing client.
  const memberRows = await client.query<SqlRow>(
      `SELECT * FROM finnor_os.pe_ic_committee_membership_versions
        WHERE tenant_id=$1 AND committee_config_version_id=$2 ORDER BY employee_id`,
      [process.tenant_id, process.committee_config_version_id],
    );
  const voteRows = await client.query<SqlRow>(
      `SELECT * FROM finnor_os.pe_ic_votes
        WHERE tenant_id=$1 AND ic_case_id=$2 AND recommendation_id=$3 AND voting_basis_version=$4
          AND recorded_at<=$5 ORDER BY employee_id,id`,
      [process.tenant_id, process.id, process.current_recommendation_id, process.voting_basis_version, at],
    );
  const dissentRows = await client.query<SqlRow>(
      `SELECT * FROM finnor_os.pe_ic_dissents
        WHERE tenant_id=$1 AND ic_case_id=$2 AND recommendation_id=$3 AND recorded_at<=$4 ORDER BY employee_id,id`,
      [process.tenant_id, process.id, process.current_recommendation_id, at],
    );
  const questionRows = await client.query<SqlRow>(
      `SELECT * FROM finnor_os.pe_ic_questions
        WHERE tenant_id=$1 AND ic_case_id=$2 AND created_at<=$3 ORDER BY created_at,id`,
      [process.tenant_id, process.id, at],
    );
  const conditionRows = await client.query<SqlRow>(
      `SELECT * FROM finnor_os.pe_ic_conditions
        WHERE tenant_id=$1 AND ic_case_id=$2 AND created_at<=$3 ORDER BY created_at,id`,
      [process.tenant_id, process.id, at],
    );
  const sourceRows = await client.query<SqlRow>(
      `SELECT * FROM finnor_os.pe_ic_source_links
        WHERE tenant_id=$1 AND ic_case_id=$2 AND created_at<=$3 ORDER BY created_at,id`,
      [process.tenant_id, process.id, at],
    );

  const members: IcCommitteeMemberSnapshot[] = memberRows.rows.map((row) => ({
    employeeId: String(row.employee_id),
    memberRole: String(row.member_role),
    votingEligible: Boolean(row.voting_eligible),
    chair: Boolean(row.chair),
    effectiveFrom: isoTimestamp(row.effective_from, "committee effectiveFrom"),
    effectiveUntil: row.effective_until ? isoTimestamp(row.effective_until, "committee effectiveUntil") : null,
  }));
  const votes: IcVoteSnapshot[] = voteRows.rows.map((row) => ({
    id: String(row.id),
    employeeId: String(row.employee_id),
    choice: row.choice as IcVoteChoice,
    recordedAt: isoTimestamp(row.recorded_at, "Vote recordedAt"),
  }));
  const questions: IcQuestionSnapshot[] = questionRows.rows.map((row) => ({
    id: String(row.id),
    state: row.state as IcQuestionState,
    requiredBeforeVote: Boolean(row.required_before_vote),
    requiredBeforeDecision: Boolean(row.required_before_decision),
  }));
  const conditions: IcConditionSnapshot[] = conditionRows.rows.map((row) => ({
    id: String(row.id),
    type: row.condition_type as IcConditionType,
    state: row.state as IcConditionState,
    required: Boolean(row.required),
  }));
  const aggregationInput: IcAggregationInput = {
    asOf: at.toISOString(),
    committeeConfigVersionId: process.committee_config_version_id,
    recommendationId: process.current_recommendation_id,
    recommendationOutcome: recommendation.outcome as IcRecommendationOutcome,
    memoId: process.current_memo_id,
    underwritingRunId: process.primary_underwriting_run_id,
    policy: policy.snapshot,
    members,
    votes,
    questions,
    conditions,
  };
  const aggregation = aggregateIcDecision(aggregationInput);
  const links = sourceRows.rows;
  const voteSnapshot = voteRows.rows.map((row) => ({
    id: row.id,
    employeeId: row.employee_id,
    recommendationId: row.recommendation_id,
    memoId: row.memo_id,
    underwritingRunId: row.underwriting_run_id,
    votingBasisVersion: Number(row.voting_basis_version),
    choice: row.choice,
    rationaleHash: row.rationale ? icSemanticHash(row.rationale) : null,
    recordedAt: isoTimestamp(row.recorded_at, "Vote recordedAt"),
  }));
  const dissentSnapshot = dissentRows.rows.map((row) => ({
    id: row.id,
    voteId: row.vote_id,
    employeeId: row.employee_id,
    recommendationId: row.recommendation_id,
    memoId: row.memo_id,
    rationaleHash: icSemanticHash(row.rationale),
    sources: sourceSummaries(links, "DISSENT", String(row.id)),
    recordedAt: isoTimestamp(row.recorded_at, "Dissent recordedAt"),
  }));
  const questionSnapshot = questionRows.rows.map((row) => ({
    id: row.id,
    state: row.state,
    version: Number(row.version),
    priority: row.priority,
    requiredBeforeVote: Boolean(row.required_before_vote),
    requiredBeforeDecision: Boolean(row.required_before_decision),
    substantiationStatus: row.substantiation_status,
    questionHash: icSemanticHash(row.question),
    answerHash: row.answer ? icSemanticHash(row.answer) : null,
    sources: sourceSummaries(links, "QUESTION", String(row.id)),
  }));
  const conditionSnapshot = conditionRows.rows.map((row) => ({
    id: row.id,
    sourceRecommendationId: row.source_recommendation_id,
    type: row.condition_type,
    state: row.state,
    version: Number(row.version),
    required: Boolean(row.required),
    evidenceRequired: Boolean(row.evidence_required),
    title: row.title,
    descriptionHash: icSemanticHash(row.description),
    sources: sourceSummaries(links, "CONDITION", String(row.id)),
  }));
  const proposedDecision = {
    schemaVersion: "pe-ic-decision-proposal.v1",
    processStatus: aggregation.process.status,
    outcome: aggregation.proposedOutcome,
    recommendationId: process.current_recommendation_id,
    memoId: process.current_memo_id,
    underwritingRunId: process.primary_underwriting_run_id,
    committeeConfigVersionId: process.committee_config_version_id,
    aggregationInputHash: aggregation.inputHash,
  };
  return { policy, aggregation, voteSnapshot, dissentSnapshot, questionSnapshot, conditionSnapshot, proposedDecision };
}

async function insertDecisionProposalTx(client: PeClient, params: {
  process: IcCaseRow;
  material: IcProposalMaterial;
  idempotencyKey: string;
  actorId: string;
  id?: string;
}): Promise<{ row: SqlRow; idempotent: boolean }> {
  const existingByKey = (await client.query<SqlRow>(
    "SELECT * FROM finnor_os.pe_ic_decision_proposals WHERE tenant_id=$1 AND idempotency_key=$2",
    [params.process.tenant_id, params.idempotencyKey],
  )).rows[0];
  if (existingByKey) {
    if (existingByKey.ic_case_id !== params.process.id || existingByKey.input_hash !== params.material.aggregation.inputHash) {
      throw new PeDomainError("IC_IDEMPOTENCY_CONFLICT", "DecisionProposal idempotency key has different immutable input");
    }
    return { row: existingByKey, idempotent: true };
  }
  const existingByInput = (await client.query<SqlRow>(
    "SELECT * FROM finnor_os.pe_ic_decision_proposals WHERE tenant_id=$1 AND ic_case_id=$2 AND input_hash=$3",
    [params.process.tenant_id, params.process.id, params.material.aggregation.inputHash],
  )).rows[0];
  if (existingByInput) return { row: existingByInput, idempotent: true };

  const row = (await client.query<SqlRow>(
    `INSERT INTO finnor_os.pe_ic_decision_proposals(
       id,tenant_id,deal_id,investment_case_id,ic_case_id,case_version,vote_set_version,
       committee_config_version_id,recommendation_id,memo_id,underwriting_run_id,aggregation,
       vote_snapshot,dissent_snapshot,question_snapshot,condition_snapshot,process_status,
       proposed_outcome,proposed_decision,input_hash,provenance_hash,idempotency_key,created_by
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,
       $17,$18,$19::jsonb,$20,
       'sha256:'||encode(public.digest(convert_to(jsonb_build_object(
         'aggregation',$12::jsonb,'votes',$13::jsonb,'dissents',$14::jsonb,
         'questions',$15::jsonb,'conditions',$16::jsonb,'proposedDecision',$19::jsonb
       )::text,'UTF8'),'sha256'),'hex'),$21,$22)
     RETURNING *`,
    [params.id ?? randomUUID(), params.process.tenant_id, params.process.deal_id, params.process.investment_case_id,
      params.process.id, Number(params.process.version), Number(params.process.vote_set_version),
      params.process.committee_config_version_id, params.process.current_recommendation_id, params.process.current_memo_id,
      params.process.primary_underwriting_run_id, JSON.stringify(params.material.aggregation),
      JSON.stringify(params.material.voteSnapshot), JSON.stringify(params.material.dissentSnapshot),
      JSON.stringify(params.material.questionSnapshot), JSON.stringify(params.material.conditionSnapshot),
      params.material.aggregation.process.status, params.material.aggregation.proposedOutcome,
      JSON.stringify(params.material.proposedDecision), params.material.aggregation.inputHash,
      params.idempotencyKey, params.actorId],
  )).rows[0]!;
  return { row, idempotent: false };
}

export async function prepareIcDecisionProposal(ctx: PeMutationContext, input: {
  id?: string;
  icCaseId: string;
  expectedCaseVersion: number;
  expectedVoteSetVersion: number;
  idempotencyKey: string;
}): Promise<{ proposal: Record<string, unknown>; aggregation: IcAggregationResult; idempotent: boolean }> {
  const bound = actorBoundContext(ctx);
  const actorId = canonicalActor(bound);
  assertIdempotencyKey(input.idempotencyKey);
  const persistedKey = proposalIdempotencyKey("prepare", input.idempotencyKey);
  return peTransaction(bound, async (_db, client) => {
    const keyed = (await client.query<SqlRow>(
      "SELECT * FROM finnor_os.pe_ic_decision_proposals WHERE tenant_id=$1 AND idempotency_key=$2",
      [bound.auth.tenantId, persistedKey],
    )).rows[0];
    if (keyed) {
      if (keyed.ic_case_id !== input.icCaseId || Number(keyed.case_version) !== input.expectedCaseVersion
        || Number(keyed.vote_set_version) !== input.expectedVoteSetVersion) {
        throw new PeDomainError("IC_IDEMPOTENCY_CONFLICT", "DecisionProposal idempotency key has different immutable input");
      }
      return { proposal: shapePeRow(keyed), aggregation: keyed.aggregation as IcAggregationResult, idempotent: true };
    }
    const process = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
    expectedVersion(Number(process.version), input.expectedCaseVersion, "ICCase");
    if (Number(process.vote_set_version) !== input.expectedVoteSetVersion) {
      throw new PeDomainError("IC_STALE_PRECONDITION", "IC Vote set changed since it was read", { expectedVoteSetVersion: input.expectedVoteSetVersion, actualVoteSetVersion: process.vote_set_version });
    }
    if (!(["VOTING", "CONDITIONS_PENDING"] as IcCaseState[]).includes(process.state)) {
      throw new PeDomainError("IC_INVALID_TRANSITION", `DecisionProposal requires VOTING or CONDITIONS_PENDING, found ${process.state}`);
    }
    const material = await buildProposalMaterialTx(client, process, new Date());
    if (input.id) assertPeUuid(input.id, "decisionProposalId");
    const inserted = await insertDecisionProposalTx(client, { process, material, idempotencyKey: persistedKey, actorId, id: input.id });
    return { proposal: shapePeRow(inserted.row), aggregation: inserted.row.aggregation as IcAggregationResult, idempotent: inserted.idempotent };
  });
}

export async function closeIcVoting(ctx: PeMutationContext, input: {
  icCaseId: string;
  expectedCaseVersion: number;
  expectedVoteSetVersion: number;
  idempotencyKey: string;
}): Promise<{ case: Record<string, unknown>; proposal: Record<string, unknown>; receiptId: string; aggregation: IcAggregationResult; idempotent: boolean }> {
  const bound = actorBoundContext(ctx);
  const actorId = canonicalActor(bound);
  assertIdempotencyKey(input.idempotencyKey);
  const authorityDecision = await authority(bound, "ic:close_voting", input.icCaseId);
  const persistedProposalKey = proposalIdempotencyKey("close", input.idempotencyKey);
  try {
    return await peTransaction(bound, async (db, client) => {
    let process = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
    if (process.voting_close_idempotency_key === input.idempotencyKey && ["CONDITIONS_PENDING", "DECIDED", "SUPERSEDED"].includes(process.state)) {
      const proposal = (await client.query<SqlRow>(
        "SELECT * FROM finnor_os.pe_ic_decision_proposals WHERE tenant_id=$1 AND idempotency_key=$2",
        [bound.auth.tenantId, persistedProposalKey],
      )).rows[0];
      if (!proposal) throw new PeDomainError("IC_CORRUPT_TRUTH", "Closed voting is missing its immutable DecisionProposal");
      const receipt = (await client.query<{ proposed_action: unknown }>(
        "SELECT proposed_action FROM finnor_os.decision_receipts WHERE tenant_id=$1 AND id=$2",
        [bound.auth.tenantId, process.voting_close_receipt_id],
      )).rows[0];
      const proposed = record(receipt?.proposed_action);
      if (Number(proposed.expectedCaseVersion) !== input.expectedCaseVersion
        || Number(proposed.expectedVoteSetVersion) !== input.expectedVoteSetVersion) {
        throw new PeDomainError("IC_IDEMPOTENCY_CONFLICT", "Voting was closed by a different immutable request");
      }
      return {
        case: shapePeRow(process), proposal: shapePeRow(proposal), receiptId: String(process.voting_close_receipt_id),
        aggregation: proposal.aggregation as IcAggregationResult, idempotent: true,
      };
    }
    expectedVersion(Number(process.version), input.expectedCaseVersion, "ICCase");
    if (Number(process.vote_set_version) !== input.expectedVoteSetVersion) {
      throw new PeDomainError("IC_STALE_PRECONDITION", "IC Vote set changed since it was read", { expectedVoteSetVersion: input.expectedVoteSetVersion, actualVoteSetVersion: process.vote_set_version });
    }
    if (process.state !== "VOTING") throw new PeDomainError("IC_VOTING_NOT_OPEN", `Voting can close only from VOTING, found ${process.state}`);
    const at = new Date();
    const material = await buildProposalMaterialTx(client, process, at);
    if (material.aggregation.process.status !== "PROCESS_ELIGIBLE") {
      throw new PeDomainError("IC_DECISION_BLOCKED", "Pinned IC policy blocks voting closure", {
        blockers: material.aggregation.process.blockers,
        aggregation: material.aggregation,
      });
    }
    const proposalId = randomUUID();
    const actual = {
      icCaseId: process.id,
      state: "CONDITIONS_PENDING",
      decisionProposalId: proposalId,
      aggregationInputHash: material.aggregation.inputHash,
      processStatus: material.aggregation.process.status,
    };
    const receiptId = await governanceReceiptTx(db, {
      tenantId: bound.auth.tenantId,
      actorId,
      objective: "Close governed IC voting and freeze the exact decision proposal",
      evidence: [
        { source: "pe_ic_recommendation", ref: String(process.current_recommendation_id), timestamp: at.toISOString() },
        { source: "pe_ic_memo", ref: String(process.current_memo_id), timestamp: at.toISOString() },
        { source: "underwriting_run", ref: String(process.primary_underwriting_run_id), timestamp: at.toISOString() },
        { source: "authority_decision", ref: authorityDecision.id, timestamp: at.toISOString() },
      ],
      policy: { id: material.policy.id, version: material.policy.version },
      proposedAction: { action: "close_ic_voting", icCaseId: process.id, expectedCaseVersion: input.expectedCaseVersion, expectedVoteSetVersion: input.expectedVoteSetVersion, idempotencyKey: input.idempotencyKey },
      actualResult: actual,
      correlationId: bound.auth.correlationId,
    });
    const updated = (await client.query<IcCaseRow>(
      `UPDATE finnor_os.pe_ic_cases SET state='CONDITIONS_PENDING',voting_closed_by=$3,
         voting_close_authority_decision_id=$4,voting_close_receipt_id=$5,voting_close_idempotency_key=$6,
         voting_closed_at=$7,version=version+1,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2 AND version=$8 AND vote_set_version=$9 RETURNING *`,
      [bound.auth.tenantId, process.id, actorId, authorityDecision.id, receiptId, input.idempotencyKey,
        at, input.expectedCaseVersion, input.expectedVoteSetVersion],
    )).rows[0];
    if (!updated) throw new PeDomainError("IC_STALE_PRECONDITION", "ICCase or Vote set changed while closing voting");
    process = updated;
    const inserted = await insertDecisionProposalTx(client, {
      process, material, idempotencyKey: persistedProposalKey, actorId, id: proposalId,
    });
    return {
      case: shapePeRow(process), proposal: shapePeRow(inserted.row), receiptId,
      aggregation: inserted.row.aggregation as IcAggregationResult, idempotent: false,
    };
    });
  } catch (error) {
    if (error instanceof PeDomainError && error.code === "IC_DECISION_BLOCKED") {
      const details = record(error.details);
      const aggregation = record(details.aggregation);
      if (record(aggregation.quorum).status === "NOT_MET") {
        emitIcMetric(bound, "ic_quorum_failures", { icCaseId: input.icCaseId, state: "VOTING", result: "blocked" });
      }
      if (["NOT_MET", "BLOCKED_CONFIG"].includes(String(record(aggregation.threshold).status))) {
        emitIcMetric(bound, "ic_threshold_failures", { icCaseId: input.icCaseId, state: "VOTING", result: "blocked" });
      }
    }
    throw error;
  }
}

function conditionDecisionRelationship(state: IcConditionState):
  "PROPOSED_AT_DECISION" | "ACTIVE_AT_DECISION" | "SATISFIED_BEFORE_DECISION" |
  "WAIVED_BEFORE_DECISION" | "FAILED_BEFORE_DECISION" | "SUPERSEDED_BEFORE_DECISION" {
  if (state === "PROPOSED") return "PROPOSED_AT_DECISION";
  if (state === "ACTIVE") return "ACTIVE_AT_DECISION";
  if (state === "SATISFIED") return "SATISFIED_BEFORE_DECISION";
  if (state === "WAIVED") return "WAIVED_BEFORE_DECISION";
  if (state === "FAILED") return "FAILED_BEFORE_DECISION";
  return "SUPERSEDED_BEFORE_DECISION";
}

export async function finalizeIcDecision(ctx: PeMutationContext, input: {
  icCaseId: string;
  decisionProposalId: string;
  expectedCaseVersion: number;
  title: string;
  rationale: string;
  idempotencyKey: string;
}): Promise<{
  case: Record<string, unknown>;
  proposal: Record<string, unknown>;
  decision: Record<string, unknown>;
  decisionLink: Record<string, unknown>;
  receiptId: string;
  authorityDecisionId: string;
  idempotent: boolean;
}> {
  const bound = actorBoundContext(ctx);
  const actorId = canonicalActor(bound);
  [input.icCaseId, input.decisionProposalId].forEach((id) => assertPeUuid(id, "IC finalization reference"));
  assertPeText(input.title, "IC Decision title");
  assertPeText(input.rationale, "IC Decision rationale");
  if (input.title.length > 500) throw new PeDomainError("IC_INVALID_INPUT", "IC Decision title exceeds 500 characters");
  if (input.rationale.length > 20_000) throw new PeDomainError("IC_INVALID_INPUT", "IC Decision rationale exceeds 20,000 characters");
  assertIdempotencyKey(input.idempotencyKey);
  const authorityDecision = await authority(bound, "ic:finalize_decision", input.icCaseId);
  try {
    const result = await peTransaction(bound, async (db, client) => {
    let process = await loadCaseForUpdate(client, bound.auth.tenantId, input.icCaseId);
    const existing = (await client.query<SqlRow>(
      `SELECT relation.*,decision.state decision_state,decision.decision,decision.title decision_title,
              decision.rationale decision_rationale,receipt.actual_result receipt_actual_result,
              receipt.proposed_action receipt_proposed_action
         FROM finnor_os.pe_ic_decision_links relation
         JOIN finnor_os.pe_decisions decision ON decision.tenant_id=relation.tenant_id AND decision.id=relation.decision_id
         JOIN finnor_os.decision_receipts receipt ON receipt.tenant_id=relation.tenant_id AND receipt.id=relation.decision_receipt_id
        WHERE relation.tenant_id=$1 AND relation.ic_case_id=$2`,
      [bound.auth.tenantId, process.id],
    )).rows[0];
    if (existing) {
      if (existing.decision_proposal_id !== input.decisionProposalId) {
        throw new PeDomainError("IC_FINALIZATION_CONFLICT", "ICCase was finalized from a different immutable DecisionProposal");
      }
      const proposed = record(existing.receipt_proposed_action);
      if (proposed.idempotencyKey !== input.idempotencyKey
        || Number(proposed.expectedCaseVersion) !== input.expectedCaseVersion
        || existing.decision_title !== input.title.trim()
        || existing.decision_rationale !== input.rationale.trim()) {
        throw new PeDomainError("IC_IDEMPOTENCY_CONFLICT", "ICCase was finalized by a different immutable request");
      }
      const proposal = (await client.query<SqlRow>("SELECT * FROM finnor_os.pe_ic_decision_proposals WHERE tenant_id=$1 AND id=$2", [bound.auth.tenantId, input.decisionProposalId])).rows[0]!;
      const decision = (await client.query<SqlRow>("SELECT * FROM finnor_os.pe_decisions WHERE tenant_id=$1 AND id=$2", [bound.auth.tenantId, existing.decision_id])).rows[0]!;
      return {
        case: shapePeRow(process), proposal: shapePeRow(proposal), decision: shapePeRow(decision),
        decisionLink: shapePeRow(existing), receiptId: String(existing.decision_receipt_id),
        authorityDecisionId: String(existing.authority_decision_id), idempotent: true,
      };
    }
    expectedVersion(Number(process.version), input.expectedCaseVersion, "ICCase");
    if (process.state !== "CONDITIONS_PENDING") throw new PeDomainError("IC_INVALID_TRANSITION", `Final Decision requires CONDITIONS_PENDING, found ${process.state}`);
    const proposal = (await client.query<SqlRow>(
      "SELECT * FROM finnor_os.pe_ic_decision_proposals WHERE tenant_id=$1 AND ic_case_id=$2 AND id=$3",
      [bound.auth.tenantId, process.id, input.decisionProposalId],
    )).rows[0];
    if (!proposal) throw new PeDomainError("IC_PROPOSAL_NOT_FOUND", "Exact IC DecisionProposal was not found");
    if (proposal.process_status !== "PROCESS_ELIGIBLE" || Number(proposal.case_version) !== Number(process.version)
      || Number(proposal.vote_set_version) !== Number(process.vote_set_version)) {
      throw new PeDomainError("IC_STALE_PROPOSAL", "DecisionProposal is blocked or stale; prepare a proposal from current process truth", {
        proposalCaseVersion: proposal.case_version, actualCaseVersion: process.version,
        proposalVoteSetVersion: proposal.vote_set_version, actualVoteSetVersion: process.vote_set_version,
      });
    }
    const storedAggregation = proposal.aggregation as IcAggregationResult;
    const proofAt = new Date(storedAggregation.asOf);
    if (!Number.isFinite(proofAt.valueOf())) throw new PeDomainError("IC_CORRUPT_TRUTH", "DecisionProposal aggregation timestamp is invalid");
    const replay = await buildProposalMaterialTx(client, process, proofAt);
    const replayExact = replay.aggregation.inputHash === proposal.input_hash
      && icSemanticHash(replay.aggregation) === icSemanticHash(proposal.aggregation)
      && icSemanticHash(replay.voteSnapshot) === icSemanticHash(proposal.vote_snapshot)
      && icSemanticHash(replay.dissentSnapshot) === icSemanticHash(proposal.dissent_snapshot)
      && icSemanticHash(replay.questionSnapshot) === icSemanticHash(proposal.question_snapshot)
      && icSemanticHash(replay.conditionSnapshot) === icSemanticHash(proposal.condition_snapshot)
      && icSemanticHash(replay.proposedDecision) === icSemanticHash(proposal.proposed_decision);
    if (!replayExact || replay.aggregation.process.status !== "PROCESS_ELIGIBLE") {
      throw new PeDomainError("IC_PROPOSAL_PROOF_MISMATCH", "DecisionProposal no longer reproduces from exact canonical process truth");
    }
    const outcome = String(proposal.proposed_outcome ?? "");
    if (!outcome) throw new PeDomainError("IC_DECISION_BLOCKED", "Eligible DecisionProposal has no proposed outcome");
    const decisionId = randomUUID();
    const linkId = randomUUID();
    const at = new Date();
    const policy = await policyForCase(client, bound.auth.tenantId, process.id);
    const receiptId = await governanceReceiptTx(db, {
      tenantId: bound.auth.tenantId,
      actorId,
      objective: "Finalize the canonical P1 Investment Committee Decision from exact P5 process proof",
      evidence: [
        { source: "pe_ic_decision_proposal", ref: String(proposal.id), timestamp: at.toISOString() },
        { source: "authority_decision", ref: authorityDecision.id, timestamp: at.toISOString() },
      ],
      policy: { id: policy.id, version: policy.version },
      proposedAction: {
        action: "finalize_ic_decision", icCaseId: process.id, decisionProposalId: proposal.id,
        expectedCaseVersion: input.expectedCaseVersion, title: input.title.trim(), rationale: input.rationale.trim(),
        idempotencyKey: input.idempotencyKey,
      },
      actualResult: {
        decisionId, decisionProposalId: proposal.id, icCaseId: process.id, outcome,
        provenanceHash: proposal.provenance_hash,
      },
      correlationId: bound.auth.correlationId,
    });
    const decisionCtx: PeMutationContext = {
      ...bound,
      provenance: {
        ...bound.provenance,
        sourceSystem: "@finnor/private-equity",
        externalId: `ic-decision:${proposal.id}`,
        createdBy: actorId,
        observedAt: at,
      },
    };
    const drafted = await recordDecisionTx(client, decisionCtx, {
      id: decisionId,
      dealId: process.deal_id,
      investmentCaseId: process.investment_case_id,
      decisionType: "investment_committee",
      title: input.title.trim(),
      decision: outcome,
      rationale: input.rationale.trim(),
      supersedesDecisionId: process.reconsiders_decision_id ?? undefined,
    });
    const finalized = await finalizeDecisionTx(client, decisionCtx, {
      decisionId,
      expectedVersion: Number(drafted.row.version),
      decidedBy: { partyType: "employee", partyId: actorId },
      decidedAt: at,
    });
    await linkDecisionEffectsTx(client, decisionCtx, {
      decisionId,
      effects: [{ effectType: "decision_receipt", effectId: receiptId, relationship: "records" }],
    });
    const decisionLink = (await client.query<SqlRow>(
      `INSERT INTO finnor_os.pe_ic_decision_links(
         id,tenant_id,deal_id,investment_case_id,ic_case_id,decision_proposal_id,decision_id,
         authority_decision_id,decision_receipt_id,finalized_by,finalized_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [linkId, bound.auth.tenantId, process.deal_id, process.investment_case_id, process.id, proposal.id,
        decisionId, authorityDecision.id, receiptId, actorId, at],
    )).rows[0]!;
    const conditions = (await client.query<SqlRow>(
      "SELECT id::text,state FROM finnor_os.pe_ic_conditions WHERE tenant_id=$1 AND ic_case_id=$2 ORDER BY id FOR SHARE",
      [bound.auth.tenantId, process.id],
    )).rows;
    for (const condition of conditions) {
      await client.query(
        `INSERT INTO finnor_os.pe_ic_decision_condition_links(
           tenant_id,ic_case_id,decision_link_id,condition_id,relationship
         ) VALUES($1,$2,$3,$4,$5)`,
        [bound.auth.tenantId, process.id, linkId, condition.id,
          conditionDecisionRelationship(condition.state as IcConditionState)],
      );
    }
    const decided = (await client.query<IcCaseRow>(
      `UPDATE finnor_os.pe_ic_cases SET state='DECIDED',final_decision_id=$3,closed_at=$4,
         version=version+1,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2 AND version=$5 RETURNING *`,
      [bound.auth.tenantId, process.id, decisionId, at, input.expectedCaseVersion],
    )).rows[0];
    if (!decided) throw new PeDomainError("IC_STALE_PRECONDITION", "ICCase changed while finalizing its canonical P1 Decision");
    process = decided;
    if (process.reconsiders_decision_id) {
      await client.query(
        `UPDATE finnor_os.pe_ic_cases SET state='SUPERSEDED',version=version+1,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND final_decision_id=$2 AND state='DECIDED' AND id<>$3`,
        [bound.auth.tenantId, process.reconsiders_decision_id, process.id],
      );
    }
    return {
      case: shapePeRow(process), proposal: shapePeRow(proposal), decision: finalized.row,
      decisionLink: shapePeRow(decisionLink), receiptId, authorityDecisionId: authorityDecision.id,
      idempotent: false,
    };
    });
    if (!result.idempotent) emitIcMetric(bound, "ic_decision_finalizations", {
      icCaseId: input.icCaseId, entityId: String(result.decision.id), state: "DECIDED", result: "success",
    });
    return result;
  } catch (error) {
    emitIcMetric(bound, "ic_decision_finalization_failures", {
      icCaseId: input.icCaseId, entityId: input.decisionProposalId, result: "failure",
    });
    throw error;
  }
}

interface IcHistoryRow extends SqlRow {
  entity_type: string;
  entity_id: string;
  snapshot: SqlRow;
  hash_valid: boolean;
}

function latestByCreatedAt(rows: Record<string, unknown>[]): Record<string, unknown> | null {
  return [...rows].sort((left, right) => {
    const time = String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? ""));
    return time || String(right.id ?? "").localeCompare(String(left.id ?? ""));
  })[0] ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function groundIcMemoDocumentVersion(ctx: PeMutationContext, input: {
  icCaseId: string;
  documentId: string;
  documentVersionId: string;
}): Promise<Record<string, unknown>> {
  [input.icCaseId, input.documentId, input.documentVersionId].forEach((id) => assertPeUuid(id, "IC Memo grounding reference"));
  return peTransaction(ctx, async (_db, client) => {
    const process = (await client.query<IcCaseRow>(
      "SELECT * FROM finnor_os.pe_ic_cases WHERE tenant_id=$1 AND id=$2",
      [ctx.auth.tenantId, input.icCaseId],
    )).rows[0];
    if (!process) throw new PeDomainError("IC_CASE_NOT_FOUND", "ICCase was not found in the authenticated tenant");
    const row = await requireMemoDocumentVersionTx(client, process, input.documentId, input.documentVersionId);
    return shapePeRow(row);
  }, { readOnly: true });
}

export async function groundIcCaseOpening(ctx: PeMutationContext, input: {
  dealId: string;
  investmentCaseId: string;
  committeeConfigVersionId: string;
  scheduledInternalEventId?: string;
  primaryUnderwritingRunId?: string;
  reconsidersDecisionId?: string;
}): Promise<Record<string, unknown>> {
  [input.dealId, input.investmentCaseId, input.committeeConfigVersionId].forEach((id) => assertPeUuid(id, "ICCase opening reference"));
  return peTransaction(ctx, async (_db, client) => {
    const row = (await client.query<SqlRow>(
      `SELECT investment.*,deal.status deal_status,config.policy_snapshot
         FROM finnor_os.pe_investment_cases investment
         JOIN finnor_os.pe_deals deal ON deal.tenant_id=investment.tenant_id AND deal.id=investment.deal_id
         JOIN finnor_os.pe_ic_committee_config_versions config ON config.tenant_id=investment.tenant_id AND config.id=$4
        WHERE investment.tenant_id=$1 AND investment.deal_id=$2 AND investment.id=$3`,
      [ctx.auth.tenantId, input.dealId, input.investmentCaseId, input.committeeConfigVersionId],
    )).rows[0];
    if (!row || row.state !== "active" || row.deal_status !== "active") {
      throw new PeDomainError("IC_OPENING_NOT_GROUNDED", "ICCase opening requires one active tenant-owned Deal, InvestmentCase and pinned committee configuration");
    }
    const policy = parseIcPolicySnapshot(row.policy_snapshot);
    if (input.scheduledInternalEventId) {
      assertPeUuid(input.scheduledInternalEventId, "scheduledInternalEventId");
      const event = (await client.query("SELECT 1 FROM finnor_os.internal_events WHERE tenant_id=$1 AND id=$2", [ctx.auth.tenantId, input.scheduledInternalEventId])).rows[0];
      if (!event) throw new PeDomainError("IC_EVENT_NOT_GROUNDED", "Scheduled internal event is missing or crosses tenant");
    }
    if (input.primaryUnderwritingRunId) {
      assertPeUuid(input.primaryUnderwritingRunId, "primaryUnderwritingRunId");
      const run = (await client.query<SqlRow>(
        "SELECT status,validity FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND investment_case_id=$2 AND id=$3",
        [ctx.auth.tenantId, input.investmentCaseId, input.primaryUnderwritingRunId],
      )).rows[0];
      if (!run || run.status !== "SUCCEEDED" || !policy.allowedPrimaryRunValidities.includes(run.validity as never)) {
        throw new PeDomainError("IC_RUN_NOT_ELIGIBLE", "Opening primary UnderwritingRun is missing, failed, or disallowed by pinned policy");
      }
    }
    if (input.reconsidersDecisionId) {
      assertPeUuid(input.reconsidersDecisionId, "reconsidersDecisionId");
      const decision = (await client.query(
        `SELECT 1 FROM finnor_os.pe_decisions
          WHERE tenant_id=$1 AND deal_id=$2 AND investment_case_id=$3 AND id=$4 AND state='final'`,
        [ctx.auth.tenantId, input.dealId, input.investmentCaseId, input.reconsidersDecisionId],
      )).rows[0];
      if (!decision) throw new PeDomainError("IC_RECONSIDERATION_NOT_GROUNDED", "Reconsideration must reference an exact final P1 Decision in this InvestmentCase");
    }
    return shapePeRow(row);
  }, { readOnly: true });
}

export async function groundIcUnderwritingRun(ctx: PeMutationContext, input: {
  icCaseId: string;
  underwritingRunId: string;
}): Promise<Record<string, unknown>> {
  [input.icCaseId, input.underwritingRunId].forEach((id) => assertPeUuid(id, "IC UnderwritingRun grounding reference"));
  return peTransaction(ctx, async (_db, client) => {
    const process = (await client.query<IcCaseRow>(
      "SELECT * FROM finnor_os.pe_ic_cases WHERE tenant_id=$1 AND id=$2",
      [ctx.auth.tenantId, input.icCaseId],
    )).rows[0];
    if (!process) throw new PeDomainError("IC_CASE_NOT_FOUND", "ICCase was not found in the authenticated tenant");
    const policy = await policyForCase(client, ctx.auth.tenantId, process.id);
    const row = (await client.query<SqlRow>(
      `SELECT * FROM finnor_os.underwriting_runs
        WHERE tenant_id=$1 AND investment_case_id=$2 AND id=$3`,
      [ctx.auth.tenantId, process.investment_case_id, input.underwritingRunId],
    )).rows[0];
    if (!row || row.status !== "SUCCEEDED" || !policy.snapshot.allowedPrimaryRunValidities.includes(row.validity as never)) {
      throw new PeDomainError("IC_RUN_NOT_ELIGIBLE", "Exact P4 UnderwritingRun is missing, failed, or disallowed by the pinned policy");
    }
    return shapePeRow(row);
  }, { readOnly: true });
}

export async function groundIcSourceReference(ctx: PeMutationContext, input: {
  icCaseId: string;
  source: IcSourceRef;
}): Promise<{ sourceKind: IcSourceKind; sourceId: string; canonical: Record<string, unknown> }> {
  assertPeUuid(input.icCaseId, "icCaseId");
  const columns = sourceColumns(input.source);
  return peTransaction(ctx, async (_db, client) => {
    const process = (await client.query<IcCaseRow>(
      "SELECT * FROM finnor_os.pe_ic_cases WHERE tenant_id=$1 AND id=$2",
      [ctx.auth.tenantId, input.icCaseId],
    )).rows[0];
    if (!process) throw new PeDomainError("IC_CASE_NOT_FOUND", "ICCase was not found in the authenticated tenant");
    let row: SqlRow | undefined;
    let sourceId = "";
    switch (input.source.kind) {
      case "EVIDENCE_VERSION":
        sourceId = input.source.evidenceVersionId;
        row = (await client.query<SqlRow>(
          `SELECT * FROM finnor_os.evidence_source_versions
            WHERE id=$1 AND (scope='global' OR (scope='tenant' AND tenant_id=$2))`,
          [sourceId, ctx.auth.tenantId],
        )).rows[0];
        break;
      case "ARTIFACT_ANCHOR":
        sourceId = `${input.source.documentVersionId}:${input.source.anchorId}:${input.source.anchorHash}`;
        row = (await client.query<SqlRow>(
          `SELECT snapshot.id,snapshot.version_id,node
             FROM finnor_os.artifact_ir_snapshots snapshot
             JOIN finnor_os.document_versions version
               ON version.tenant_id=snapshot.tenant_id AND version.id=snapshot.version_id,
             LATERAL jsonb_array_elements(snapshot.ir->'nodes') node
            WHERE snapshot.tenant_id=$1 AND version.document_id=$2 AND snapshot.version_id=$3
              AND node->>'id'=$4 AND node->>'hash'=$5
            ORDER BY snapshot.created_at DESC LIMIT 1`,
          [ctx.auth.tenantId, input.source.documentId, input.source.documentVersionId,
            input.source.anchorId, input.source.anchorHash],
        )).rows[0];
        break;
      case "UNDERWRITING_RUN":
        sourceId = input.source.underwritingRunId;
        row = (await client.query<SqlRow>(
          "SELECT * FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND investment_case_id=$2 AND id=$3",
          [ctx.auth.tenantId, process.investment_case_id, sourceId],
        )).rows[0];
        break;
      case "P1_WORLD": {
        sourceId = input.source.entityId;
        const resolved = (await client.query<{ tenant_id: string | null; deal_id: string | null }>(
          `SELECT finnor_os.canonical_entity_tenant($1,$2::uuid)::text tenant_id,
                  finnor_os.pe_entity_deal($1,$2::uuid)::text deal_id`,
          [input.source.entityType, sourceId],
        )).rows[0];
        if (resolved?.tenant_id === ctx.auth.tenantId && resolved.deal_id === process.deal_id) {
          row = { entity_type: input.source.entityType, entity_id: sourceId, tenant_id: resolved.tenant_id, deal_id: resolved.deal_id };
        }
        break;
      }
      case "IC_QUESTION":
        sourceId = input.source.questionId;
        row = (await client.query<SqlRow>(
          "SELECT * FROM finnor_os.pe_ic_questions WHERE tenant_id=$1 AND ic_case_id=$2 AND id=$3",
          [ctx.auth.tenantId, process.id, sourceId],
        )).rows[0];
        break;
      case "PE_RISK":
        sourceId = input.source.riskId;
        row = (await client.query<SqlRow>(
          "SELECT * FROM finnor_os.pe_deal_risks WHERE tenant_id=$1 AND deal_id=$2 AND id=$3",
          [ctx.auth.tenantId, process.deal_id, sourceId],
        )).rows[0];
        break;
      case "IC_CONDITION":
        sourceId = input.source.conditionId;
        row = (await client.query<SqlRow>(
          "SELECT * FROM finnor_os.pe_ic_conditions WHERE tenant_id=$1 AND ic_case_id=$2 AND id=$3",
          [ctx.auth.tenantId, process.id, sourceId],
        )).rows[0];
        break;
    }
    if (!row) throw new PeDomainError("IC_SOURCE_NOT_GROUNDED", "Exact IC source reference is missing or crosses its tenant/process root", { sourceKind: columns.sourceKind });
    return { sourceKind: columns.sourceKind, sourceId, canonical: shapePeRow(row) };
  }, { readOnly: true });
}

export async function listIcCases(ctx: PeMutationContext, input: { limit?: number } = {}): Promise<{
  cases: Record<string, unknown>[];
  complete: true;
}> {
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new PeDomainError("IC_READ_LIMIT", "IC Case list limit must be between 1 and 100");
  return peTransaction(ctx, async (_db, client) => {
    const rows = (await client.query<SqlRow>(
      `SELECT process.*,investment.title investment_case_title,investment.summary investment_case_summary,
              run.status underwriting_status,run.validity underwriting_validity,run.result_hash underwriting_result_hash,
              memo.document_id memo_document_id,memo.document_version_id memo_document_version_id,
              recommendation.outcome recommendation_outcome,recommendation.revision recommendation_revision
         FROM finnor_os.pe_ic_cases process
         JOIN finnor_os.pe_investment_cases investment
           ON investment.tenant_id=process.tenant_id AND investment.id=process.investment_case_id
         LEFT JOIN finnor_os.underwriting_runs run
           ON run.tenant_id=process.tenant_id AND run.id=process.primary_underwriting_run_id
         LEFT JOIN finnor_os.pe_ic_memos memo
           ON memo.tenant_id=process.tenant_id AND memo.id=process.current_memo_id
         LEFT JOIN finnor_os.pe_ic_recommendations recommendation
           ON recommendation.tenant_id=process.tenant_id AND recommendation.id=process.current_recommendation_id
        WHERE process.tenant_id=$1
        ORDER BY process.updated_at DESC,process.id
        LIMIT $2`,
      [ctx.auth.tenantId, limit],
    )).rows;
    return { cases: rows.map(shapePeRow), complete: true };
  }, { readOnly: true });
}

/** A single repeatable-read workspace projection. Past reads are reconstructed
 * from the existing canonical temporal owner; immutable semantic links are
 * bounded by their own creation timestamps. */
export async function getIcWorkspace(ctx: PeMutationContext, input: {
  icCaseId: string;
  asOf?: string;
}): Promise<IcWorkspaceReadModel> {
  assertPeUuid(input.icCaseId, "icCaseId");
  const requestedAt = input.asOf ? new Date(input.asOf) : null;
  if (requestedAt && !Number.isFinite(requestedAt.valueOf())) throw new PeDomainError("IC_INVALID_INPUT", "asOf must be an ISO timestamp");
  if (requestedAt && requestedAt.valueOf() > Date.now() + 1_000) throw new PeDomainError("IC_INVALID_INPUT", "asOf cannot be in the future");
  return peTransaction(ctx, async (_db, client) => {
    // A current projection must use the database clock. Using a JavaScript
    // timestamp captured before opening the transaction can omit a just-committed
    // canonical version when the application and database clocks differ by even
    // a few milliseconds.
    const at = requestedAt ?? (await client.query<{ at: Date }>("SELECT clock_timestamp() at")).rows[0]!.at;
    const caseHistory = (await client.query<IcHistoryRow>(
      `SELECT entity_type,entity_id::text,snapshot,
              snapshot_hash=encode(public.digest(convert_to(snapshot::text,'UTF8'),'sha256'),'hex') hash_valid
         FROM finnor_os.canonical_entity_versions
        WHERE tenant_id=$1 AND entity_type='pe_ic_case' AND entity_id=$2 AND recorded_at<=$3
        ORDER BY recorded_at DESC,entity_version DESC LIMIT 1`,
      [ctx.auth.tenantId, input.icCaseId, at],
    )).rows[0];
    if (!caseHistory) throw new PeDomainError("IC_CASE_NOT_FOUND", "ICCase did not exist at the requested asOf time");
    if (!caseHistory.hash_valid) throw new PeDomainError("IC_HISTORY_HASH_MISMATCH", "ICCase temporal snapshot hash verification failed");
    const processRaw = caseHistory.snapshot;
    const process = shapePeRow(processRaw);
    const investmentHistory = (await client.query<IcHistoryRow>(
      `SELECT entity_type,entity_id::text,snapshot,
              snapshot_hash=encode(public.digest(convert_to(snapshot::text,'UTF8'),'sha256'),'hex') hash_valid
         FROM finnor_os.canonical_entity_versions
        WHERE tenant_id=$1 AND entity_type='pe_investment_case' AND entity_id=$2 AND recorded_at<=$3
        ORDER BY recorded_at DESC,entity_version DESC LIMIT 1`,
      [ctx.auth.tenantId, String(process.investmentCaseId), at],
    )).rows[0];
    if (!investmentHistory || !investmentHistory.hash_valid) {
      throw new PeDomainError("IC_HISTORY_HASH_MISMATCH", "Pinned P1 InvestmentCase temporal truth is missing or failed hash verification");
    }
    const investmentCase = shapePeRow(investmentHistory.snapshot);

    const childHistory = (await client.query<IcHistoryRow>(
      `SELECT DISTINCT ON (entity_type,entity_id)
              entity_type,entity_id::text,snapshot,
              snapshot_hash=encode(public.digest(convert_to(snapshot::text,'UTF8'),'sha256'),'hex') hash_valid
         FROM finnor_os.canonical_entity_versions
        WHERE tenant_id=$1 AND recorded_at<=$2
          AND entity_type=ANY($3::text[]) AND snapshot->>'ic_case_id'=$4
        ORDER BY entity_type,entity_id,recorded_at DESC,entity_version DESC
        LIMIT 1001`,
      [ctx.auth.tenantId, at, [
        "pe_ic_memo", "pe_ic_question", "pe_ic_recommendation", "pe_ic_vote",
        "pe_ic_dissent", "pe_ic_condition", "pe_ic_decision_proposal",
      ], input.icCaseId],
    )).rows;
    if (childHistory.length > 1_000) throw new PeDomainError("IC_READ_LIMIT", "IC workspace exceeds the bounded 1,000-row temporal read limit");
    if (childHistory.some((row) => !row.hash_valid)) throw new PeDomainError("IC_HISTORY_HASH_MISMATCH", "IC workspace temporal snapshot hash verification failed");
    const rowsFor = (kind: string) => childHistory.filter((row) => row.entity_type === kind).map((row) => shapePeRow(row.snapshot));

    const configId = String(process.committeeConfigVersionId ?? "");
    const configRaw = (await client.query<SqlRow>(
      `SELECT * FROM finnor_os.pe_ic_committee_config_versions
        WHERE tenant_id=$1 AND id=$2 AND created_at<=$3`,
      [ctx.auth.tenantId, configId, at],
    )).rows[0];
    if (!configRaw) throw new PeDomainError("IC_BLOCKED_CONFIG", "Pinned committee configuration did not exist at the requested asOf time");
    const memberRaw = (await client.query<SqlRow>(
      `SELECT * FROM finnor_os.pe_ic_committee_membership_versions
        WHERE tenant_id=$1 AND committee_config_version_id=$2 AND created_at<=$3 ORDER BY employee_id`,
      [ctx.auth.tenantId, configId, at],
    )).rows;
    const sourceRaw = (await client.query<SqlRow>(
      `SELECT * FROM finnor_os.pe_ic_source_links
        WHERE tenant_id=$1 AND ic_case_id=$2 AND created_at<=$3 ORDER BY created_at,id LIMIT 1001`,
      [ctx.auth.tenantId, input.icCaseId, at],
    )).rows;
    if (sourceRaw.length > 1_000) throw new PeDomainError("IC_READ_LIMIT", "IC workspace exceeds the bounded 1,000 source-link read limit");
    const sourceRows = sourceRaw.map(shapePeRow);
    const sourcesFor = (kind: string, id: unknown) => sourceRows.filter((row) => row.ownerKind === kind && row.ownerId === id);

    const memos = rowsFor("pe_ic_memo");
    const questions: Array<Record<string, unknown> & { sources: Record<string, unknown>[] }> = rowsFor("pe_ic_question")
      .map((row) => Object.assign({}, row, { sources: sourcesFor("QUESTION", row.id) }));
    const recommendations = rowsFor("pe_ic_recommendation").sort((left, right) => Number(left.revision) - Number(right.revision));
    const votes = rowsFor("pe_ic_vote");
    const dissents: Array<Record<string, unknown> & { sources: Record<string, unknown>[] }> = rowsFor("pe_ic_dissent")
      .map((row) => Object.assign({}, row, { sources: sourcesFor("DISSENT", row.id) }));
    const conditions: Array<Record<string, unknown> & { sources: Record<string, unknown>[] }> = rowsFor("pe_ic_condition")
      .map((row) => Object.assign({}, row, { sources: sourcesFor("CONDITION", row.id) }));
    const proposals = rowsFor("pe_ic_decision_proposal");
    const currentProposal = latestByCreatedAt(proposals);
    const currentMemo = memos.find((row) => row.id === process.currentMemoId) ?? null;
    const currentDeck = memos.find((row) => row.id === process.currentDeckId) ?? null;
    const currentRecommendation = recommendations.find((row) => row.id === process.currentRecommendationId) ?? null;

    const artifactProjection = async (selection: Record<string, unknown> | null): Promise<Record<string, unknown> | null> => {
      if (!selection) return null;
      const row = (await client.query<SqlRow>(
        `SELECT document.id::text document_id,document.title document_title,
                version.id::text document_version_id,version.version_ordinal,version.origin,version.format,
                version.media_type,version.byte_sha256,version.size_bytes,version.created_at,
                review.state review_state,review.created_at review_recorded_at,
                ir.semantic_hash,ir.parse_status,ir.fidelity_status,ir.calculation_status,
                (SELECT count(*)::int FROM finnor_os.artifact_bindings binding
                  WHERE binding.tenant_id=version.tenant_id AND binding.version_id=version.id AND binding.created_at<=$4) citation_count
           FROM finnor_os.document_versions version
           JOIN finnor_os.documents document ON document.tenant_id=version.tenant_id AND document.id=version.document_id
           LEFT JOIN LATERAL (
             SELECT state,created_at FROM finnor_os.artifact_reviews
              WHERE tenant_id=version.tenant_id AND version_id=version.id AND created_at<=$4
              ORDER BY created_at DESC,id DESC LIMIT 1
           ) review ON true
           LEFT JOIN LATERAL (
             SELECT semantic_hash,parse_status,fidelity_status,calculation_status
               FROM finnor_os.artifact_ir_snapshots
              WHERE tenant_id=version.tenant_id AND version_id=version.id AND created_at<=$4
              ORDER BY created_at DESC,parser_schema DESC LIMIT 1
           ) ir ON true
          WHERE version.tenant_id=$1 AND version.document_id=$2 AND version.id=$3 AND version.created_at<=$4`,
        [ctx.auth.tenantId, String(selection.documentId), String(selection.documentVersionId), at],
      )).rows[0];
      if (!row) throw new PeDomainError("IC_CORRUPT_TRUTH", "Pinned P3 DocumentVersion is unavailable at the requested asOf time");
      return shapePeRow(row);
    };
    const memoArtifact = await artifactProjection(currentMemo);
    const deckArtifact = await artifactProjection(currentDeck);

    const policySnapshot = parseIcPolicySnapshot(configRaw.policy_snapshot);
    const memberSnapshots: IcCommitteeMemberSnapshot[] = memberRaw.map((row) => ({
      employeeId: String(row.employee_id), memberRole: String(row.member_role),
      votingEligible: Boolean(row.voting_eligible), chair: Boolean(row.chair),
      effectiveFrom: isoTimestamp(row.effective_from, "committee effectiveFrom"),
      effectiveUntil: row.effective_until ? isoTimestamp(row.effective_until, "committee effectiveUntil") : null,
    }));
    const underwritingBasis = process.primaryUnderwritingRunId
      ? await inspectUnderwritingBasisTx(
        client,
        ctx.auth.tenantId,
        String(process.investmentCaseId),
        String(process.primaryUnderwritingRunId),
        policySnapshot,
      )
      : null;
    const underwriting = underwritingBasis ? (() => {
      const shaped = shapePeRow(underwritingBasis.row);
      delete shaped.checks;
      return {
        run: shaped,
        checks: underwritingBasis.checks,
        eligibleUnderPinnedPolicy: underwritingBasis.eligible,
        eligibilityBlockers: underwritingBasis.blockers,
      };
    })() : null;
    let aggregation: IcAggregationResult | null = null;
    if (currentRecommendation && process.currentMemoId && process.primaryUnderwritingRunId) {
      aggregation = aggregateIcDecision({
        asOf: at.toISOString(),
        committeeConfigVersionId: configId,
        recommendationId: String(currentRecommendation.id),
        recommendationOutcome: currentRecommendation.outcome as IcRecommendationOutcome,
        memoId: String(process.currentMemoId),
        underwritingRunId: String(process.primaryUnderwritingRunId),
        policy: policySnapshot,
        members: memberSnapshots,
        votes: votes.filter((row) => row.recommendationId === currentRecommendation.id).map((row) => ({
          id: String(row.id), employeeId: String(row.employeeId), choice: row.choice as IcVoteChoice,
          recordedAt: isoTimestamp(row.recordedAt, "Vote recordedAt"),
        })),
        questions: questions.map((row) => ({
          id: String(row.id), state: row.state as IcQuestionState,
          requiredBeforeVote: Boolean(row.requiredBeforeVote), requiredBeforeDecision: Boolean(row.requiredBeforeDecision),
        })),
        conditions: conditions.map((row) => ({
          id: String(row.id), type: row.conditionType as IcConditionType,
          state: row.state as IcConditionState, required: Boolean(row.required),
        })),
      });
    }

    const finalDecisionId = typeof process.finalDecisionId === "string" ? process.finalDecisionId : null;
    let decision: Record<string, unknown> | null = null;
    if (finalDecisionId) {
      const history = (await client.query<IcHistoryRow>(
        `SELECT entity_type,entity_id::text,snapshot,
                snapshot_hash=encode(public.digest(convert_to(snapshot::text,'UTF8'),'sha256'),'hex') hash_valid
           FROM finnor_os.canonical_entity_versions
          WHERE tenant_id=$1 AND entity_type='pe_decision' AND entity_id=$2 AND recorded_at<=$3
          ORDER BY recorded_at DESC,entity_version DESC LIMIT 1`,
        [ctx.auth.tenantId, finalDecisionId, at],
      )).rows[0];
      if (history) {
        if (!history.hash_valid) throw new PeDomainError("IC_HISTORY_HASH_MISMATCH", "P1 Decision temporal snapshot hash verification failed");
        decision = shapePeRow(history.snapshot);
      }
    }
    const proofRaw = (await client.query<SqlRow>(
      `SELECT relation.*,to_jsonb(authority) authority_decision,to_jsonb(receipt) decision_receipt
         FROM finnor_os.pe_ic_decision_links relation
         JOIN finnor_os.authority_decisions authority ON authority.tenant_id=relation.tenant_id AND authority.id=relation.authority_decision_id
         JOIN finnor_os.decision_receipts receipt ON receipt.tenant_id=relation.tenant_id AND receipt.id=relation.decision_receipt_id
        WHERE relation.tenant_id=$1 AND relation.ic_case_id=$2 AND relation.finalized_at<=$3`,
      [ctx.auth.tenantId, input.icCaseId, at],
    )).rows[0];
    const decisionProof = proofRaw ? {
      ...shapePeRow(proofRaw),
      authorityDecision: shapePeRow(asRecord(proofRaw.authority_decision)),
      decisionReceipt: shapePeRow(asRecord(proofRaw.decision_receipt)),
    } : null;

    const state = process.state as IcCaseState;
    const requiredVoteQuestions = questions.filter((row) => Boolean(row.requiredBeforeVote) && !["RESOLVED", "WAIVED", "SUPERSEDED"].includes(String(row.state)));
    const basisComplete = Boolean(currentMemo && currentRecommendation && process.primaryUnderwritingRunId);
    const recommendationExact = Boolean(currentRecommendation
      && currentRecommendation.memoId === process.currentMemoId
      && currentRecommendation.underwritingRunId === process.primaryUnderwritingRunId);
    const currentProposalExact = Boolean(currentProposal
      && Number(currentProposal.caseVersion) === Number(process.version)
      && Number(currentProposal.voteSetVersion) === Number(process.voteSetVersion)
      && currentProposal.processStatus === "PROCESS_ELIGIBLE");
    const actorId = ctx.auth.employeeId;
    const actorMember = actorId ? memberSnapshots.find((member) => member.employeeId === actorId
      && member.votingEligible && Date.parse(member.effectiveFrom) <= at.valueOf()
      && (!member.effectiveUntil || at.valueOf() < Date.parse(member.effectiveUntil))) : undefined;
    const actorVote = actorId ? votes.find((row) => row.employeeId === actorId && row.recommendationId === process.currentRecommendationId) : undefined;
    const actorDissent = actorId ? dissents.find((row) => row.employeeId === actorId && row.recommendationId === process.currentRecommendationId) : undefined;
    const commonBasisBlockers = [
      ...(!basisComplete ? ["MISSING_EXACT_MEMO_RECOMMENDATION_OR_RUN"] : []),
      ...(basisComplete && !recommendationExact ? ["RECOMMENDATION_BASIS_STALE"] : []),
      ...(underwriting?.eligibilityBlockers ?? []),
      ...requiredVoteQuestions.map((row) => `REQUIRED_QUESTION:${String(row.id)}`),
    ];
    const controlBlockers: Record<string, string[]> = {
      beginPreparation: state === "DRAFT" ? [] : [`STATE:${state}`],
      createQuestion: ["PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN"].includes(state) ? [] : [`STATE:${state}`],
      createRecommendation: ["DECIDED", "WITHDRAWN", "SUPERSEDED"].includes(state) ? [`STATE:${state}`] : (!currentMemo || !process.primaryUnderwritingRunId ? ["MISSING_MEMO_OR_RUN"] : []),
      markReadyForVote: ["READY_FOR_REVIEW", "QUESTIONS_OPEN"].includes(state) ? commonBasisBlockers : [`STATE:${state}`],
      openVoting: state === "READY_FOR_VOTE" ? commonBasisBlockers : [`STATE:${state}`],
      recordVote: state !== "VOTING" ? [`STATE:${state}`] : (!actorMember ? ["ACTOR_NOT_ELIGIBLE_MEMBER"] : actorVote ? ["ACTOR_ALREADY_VOTED"] : []),
      recordDissent: state !== "VOTING" ? [`STATE:${state}`] : (!actorVote ? ["ACTOR_VOTE_REQUIRED"] : actorDissent ? ["ACTOR_DISSENT_ALREADY_RECORDED"] : []),
      prepareDecisionProposal: ["VOTING", "CONDITIONS_PENDING"].includes(state) ? [] : [`STATE:${state}`],
      closeVoting: state !== "VOTING" ? [`STATE:${state}`] : aggregation?.process.blockers ?? ["AGGREGATION_UNAVAILABLE"],
      finalizeDecision: state !== "CONDITIONS_PENDING" ? [`STATE:${state}`] : (!currentProposalExact ? ["CURRENT_ELIGIBLE_PROPOSAL_REQUIRED"] : []),
    };
    const controls = Object.fromEntries(Object.entries(controlBlockers).map(([key, blockers]) => [key, blockers.length === 0]));
    const readinessBlockers = state === "CONDITIONS_PENDING"
      ? (aggregation?.process.blockers ?? ["AGGREGATION_UNAVAILABLE"])
      : commonBasisBlockers;
    return {
      viewer: { employeeId: actorId ?? null },
      case: process,
      investmentCase,
      committee: { config: shapePeRow(configRaw), members: memberRaw.map(shapePeRow) },
      memo: currentMemo,
      deck: currentDeck,
      artifacts: { memo: memoArtifact, deck: deckArtifact },
      underwriting,
      questions,
      recommendations,
      currentRecommendation,
      votes,
      dissents,
      conditions,
      decisionProposal: currentProposal,
      decision,
      decisionProof,
      readiness: {
        votingEligible: state === "READY_FOR_VOTE" && commonBasisBlockers.length === 0,
        decisionEligible: state === "CONDITIONS_PENDING" && currentProposalExact && (aggregation?.process.status === "PROCESS_ELIGIBLE"),
        blockers: readinessBlockers,
        aggregation,
      },
      controls,
      controlBlockers,
      asOf: at.toISOString(),
    };
  }, { readOnly: true });
}
