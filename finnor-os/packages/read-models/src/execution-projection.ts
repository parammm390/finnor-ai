import {
  applicationAccounts,
  authProfiles,
  actionLog,
  authorityApprovalRequests,
  authorityApprovalRequestSteps,
  authorityDecisions,
  businessEffects,
  communicationDeliveries,
  communicationIdentities,
  compensationCases,
  computerRuns,
  computerSteps,
  decisionReceipts,
  domainActions,
  externalOperations,
  integrationOperations,
  reconciliationCases,
  users,
  withTenant,
  workflowRuns,
  workflowSteps,
  workEntityLinks,
  workObjectiveLoops,
  works,
} from "@finnor/db";
import { EXECUTION_COMPENSATABLE_STEP_TYPES, isRetiredWaterAction, isRetiredWaterWorkflow } from "@finnor/shared-types";
import type {
  DomainActionStatus,
  ErrorKind,
  ExecutionActionNode,
  ExecutionActor,
  ExecutionApproval,
  ExecutionAuthority,
  ExecutionComputerRun,
  ExecutionControl,
  ExecutionDependencyEdge,
  ExecutionEvidence,
  ExecutionFailure,
  ExecutionProjection,
  ExecutionReceipt,
  ExecutionProviderRoute,
  ExecutionTarget,
  ExecutionVerificationState,
  ExecutionWorkflow,
  Role,
} from "@finnor/shared-types";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";

const ACTION_LIMIT = 200;
const WORKFLOW_STEP_LIMIT = 500;
const COMPUTER_RUN_LIMIT = 20;
const COMPUTER_STEP_LIMIT = 40;
const EVIDENCE_LIMIT = 20;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SECRET_KEY = /secret|password|passcode|access[\s_-]?token|refresh[\s_-]?token|private[\s_-]?key|api[\s_-]?key|credential|cookie|session[\s_-]?storage|local[\s_-]?storage|authorization|provider[\s_-]?session|auth[\s_-]?profile[\s_-]?ref/i;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:ste|sk)[_-][A-Za-z0-9_-]{16,}\b/gi,
  /\bAKIA[A-Z0-9]{16}\b/g,
];
const ERROR_KINDS = new Set<ErrorKind>(["retryable", "terminal", "conflict", "auth", "validation", "provider_down", "needs_human", "config", "unknown_outcome"]);
const COMPENSATABLE_STEPS = new Set<string>(EXECUTION_COMPENSATABLE_STEP_TYPES);

export interface ExecutionProjectionViewer {
  userId: string;
  role: Role;
  approvableActionIds?: readonly string[];
  canControlRuns?: boolean;
  canCancelComputer?: boolean;
}

function stringField(value: unknown, key: string, depth = 0): string | null {
  if (depth > 6 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) {
      const found = stringField(item, key, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row[key] === "string") return row[key];
  for (const nested of Object.values(row).slice(0, 100)) {
    const found = stringField(nested, key, depth + 1);
    if (found) return found;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function iso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function boundedString(value: string): string {
  const redacted = SECRET_VALUE_PATTERNS.reduce((current, pattern) => {
    pattern.lastIndex = 0;
    return current.replace(pattern, "[REDACTED]");
  }, value);
  return redacted.length <= 2_000 ? redacted : `${redacted.slice(0, 2_000)}…`;
}

/** Shared server boundary for action payloads, receipt results, computer results,
 * and failure details. Secret-shaped fields are removed for every active viewer. */
export function sanitizeExecutionValue(value: unknown, role: Role, depth = 0): unknown {
  if (depth > 7) return "[TRUNCATED]";
  if (typeof value === "string") return boundedString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeExecutionValue(item, role, depth + 1));
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 80).flatMap(([key, nested]) => {
    if (SECRET_KEY.test(key)) return [];
    return [[key, sanitizeExecutionValue(nested, role, depth + 1)]];
  }));
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

const ID_FIELDS: Record<string, string> = {
  dealId: "pe_deal",
  workstreamId: "pe_workstream",
  requestId: "pe_deal_request",
  requestedFromDealPartyId: "pe_deal_party",
  deliverableId: "pe_deliverable",
  findingId: "pe_finding",
  dealRiskId: "pe_deal_risk",
  dependencyId: "pe_dependency",
  closingConditionId: "pe_closing_condition",
  closingItemId: "pe_closing_item",
  evidenceSourceId: "evidence_source",
  evidenceVersionId: "evidence_source_version",
  verifierEmployeeId: "user",
  documentId: "document",
  taskId: "task",
  delegationId: "delegation",
};

function collectTargetRefs(value: unknown, out = new Map<string, { entityType: string; entityId: string; sourceRef: string }>(), path = "payload", depth = 0) {
  if (depth > 6 || value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.slice(0, 100).forEach((item, index) => collectTargetRefs(item, out, `${path}[${index}]`, depth + 1));
    return out;
  }
  if (typeof value !== "object") return out;
  const row = value as Record<string, unknown>;
  const entityType = typeof row.entityType === "string" ? row.entityType : typeof row.partyType === "string" ? row.partyType : null;
  const entityId = typeof row.entityId === "string" ? row.entityId : typeof row.partyId === "string" ? row.partyId : null;
  if (entityType && entityId) out.set(`${entityType}:${entityId}`, { entityType, entityId, sourceRef: path });
  for (const [key, nested] of Object.entries(row)) {
    const type = ID_FIELDS[key];
    if (type && typeof nested === "string") out.set(`${type}:${nested}`, { entityType: type, entityId: nested, sourceRef: `${path}.${key}` });
    collectTargetRefs(nested, out, `${path}.${key}`, depth + 1);
  }
  return out;
}

function errorKind(value: unknown): ErrorKind | null {
  return typeof value === "string" && ERROR_KINDS.has(value as ErrorKind) ? value as ErrorKind : null;
}

function failureFrom(value: unknown, sourceRef: string): ExecutionFailure | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const kind = errorKind(row.errorKind ?? row.kind);
  const message = typeof row.message === "string" ? boundedString(row.message) : typeof row.error === "string" ? boundedString(row.error) : null;
  if (!kind && !message) return null;
  const reconciliationRequired = kind === "unknown_outcome" || row.reconciliationRequired === true;
  return {
    errorKind: kind,
    message: message ?? humanize(kind ?? "execution failure"),
    recoveryPath: typeof row.recoveryPath === "string" ? boundedString(row.recoveryPath) : null,
    reconciliationRequired,
    retrySafe: !reconciliationRequired && (kind === "retryable" || kind === "provider_down"),
    humanRequired: reconciliationRequired || kind === "needs_human" || kind === "auth" || kind === "config" || kind === "terminal",
    sourceRef,
  };
}

function evidenceFrom(value: unknown, role: Role): { rows: ExecutionEvidence[]; truncated: boolean } {
  const raw = Array.isArray(value) ? value : [];
  return {
    rows: raw.slice(0, EVIDENCE_LIMIT).flatMap((item) => {
      const row = record(item);
      if (typeof row.source !== "string" || typeof row.timestamp !== "string") return [];
      return [{
        source: row.source,
        ref: typeof row.ref === "string" ? row.ref : null,
        timestamp: row.timestamp,
        restricted: false,
      } satisfies ExecutionEvidence];
    }),
    truncated: raw.length > EVIDENCE_LIMIT,
  };
}

function actorFrom(row: { id: string; displayName: string | null; role: string } | undefined): ExecutionActor | null {
  if (!row) return null;
  return {
    employeeId: row.id,
    displayName: row.displayName,
    role: row.role === "owner" ? "owner" : null,
    sourceRef: `users:${row.id}`,
  };
}

export function deriveExecutionNodeStatus(params: {
  sourceStatus: DomainActionStatus;
  dependencyStatuses: DomainActionStatus[];
  verification: ExecutionVerificationState;
  authorityState?: ExecutionAuthority["state"];
  computerStatus?: string | null;
  effectExecutionStates?: string[];
}): ExecutionActionNode["status"] {
  if (params.authorityState === "denied" || params.authorityState === "authority_changed" || params.authorityState === "reauthorization_required") return "denied";
  if (params.computerStatus && !["succeeded", "blocked", "failed", "timed_out", "cancelled"].includes(params.computerStatus)) return "executing";
  if (params.sourceStatus === "draft") {
    if (params.dependencyStatuses.some((status) => ["failed", "rejected", "needs_human_review", "blocked_integration_unavailable"].includes(status))) return "blocked";
    return params.dependencyStatuses.every((status) => status === "completed") ? "runnable" : "waiting_dependency";
  }
  if (params.sourceStatus === "pending") return "awaiting_approval";
  if (params.sourceStatus === "approved") return "approved";
  if (params.sourceStatus === "executing") {
    if (params.effectExecutionStates?.some((state) => state === "reconciling" || state === "failed_after_possible_effect" || state === "cancellation_requested")) return "reconciling";
    if (params.effectExecutionStates?.length && params.effectExecutionStates.every((state) => state === "authorized")) return "queued";
    return "executing";
  }
  if (params.sourceStatus === "completed") return params.verification === "verified" ? "succeeded" : "verifying";
  if (params.sourceStatus === "rejected") return "rejected";
  if (params.sourceStatus === "failed") return "failed";
  return "blocked";
}

function edgeState(status: ExecutionActionNode["status"]): ExecutionDependencyEdge["state"] {
  if (status === "succeeded") return "succeeded";
  if (status === "failed" || status === "denied" || status === "rejected") return "failed";
  if (status === "blocked") return "blocked";
  if (status === "runnable" || status === "approved" || status === "queued" || status === "executing" || status === "reconciling" || status === "verifying") return "runnable";
  return "waiting";
}

function workflowControls(status: ExecutionWorkflow["status"], id: string, version: number, allowed: boolean, retryUnsafe: boolean): ExecutionControl[] {
  if (!allowed) return [];
  const control = (kind: ExecutionControl["kind"], label: string, reason: string): ExecutionControl => ({ kind, label, endpoint: `/api/workflows/runs/${id}/${kind}`, method: "POST", expectedVersion: version, reason });
  if (status === "running") return [control("pause", "Pause", "Running workflows may be paused."), control("cancel", "Cancel", "Cancellation stops future eligible steps; completed effects remain."), control("escalate", "Escalate", "Running workflows may be escalated for human ownership.")];
  if (status === "paused") return [control("resume", "Continue", "Paused workflows may resume."), control("cancel", "Cancel", "Cancellation stops future eligible steps; completed effects remain.")];
  if (status === "failed") return [
    ...(retryUnsafe ? [] : [control("retry", "Retry", "The failed run has no open reconciliation or unknown effect.")]),
    control("escalate", "Escalate", "Failed workflows may be escalated."),
  ];
  return [];
}

export async function executionActionTypes(tenantId: string, workId: string): Promise<Array<{ id: string; actionType: string; status: DomainActionStatus }>> {
  return withTenant(tenantId, (db) => db.select({ id: domainActions.id, actionType: domainActions.actionType, status: domainActions.status })
    .from(domainActions).where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.workId, workId))));
}

/** One bounded read model over existing durable execution truth. */
export async function executionProjection(
  tenantId: string,
  workId: string,
  viewer: ExecutionProjectionViewer,
): Promise<ExecutionProjection | null> {
  return withTenant(tenantId, async (db) => {
    const [work] = await db.select().from(works).where(and(eq(works.tenantId, tenantId), eq(works.id, workId))).limit(1);
    if (!work) return null;

    // withTenant owns one transaction-bound pg client. Keep queries sequential so
    // every row comes from one coherent snapshot and pg@9 never rejects concurrent
    // client.query() calls on that connection.
    const actionRowsPlus = await db.select().from(domainActions).where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.workId, workId))).orderBy(asc(domainActions.createdAt), asc(domainActions.id)).limit(ACTION_LIMIT + 1);
    const linkRows = await db.select().from(workEntityLinks).where(and(eq(workEntityLinks.tenantId, tenantId), eq(workEntityLinks.workId, workId))).orderBy(asc(workEntityLinks.createdAt));
    const runRows = await db.select().from(workflowRuns).where(and(eq(workflowRuns.tenantId, tenantId), eq(workflowRuns.workId, workId))).orderBy(asc(workflowRuns.createdAt));
    const objectiveRows = await db.select().from(workObjectiveLoops).where(and(eq(workObjectiveLoops.tenantId, tenantId), eq(workObjectiveLoops.workId, workId))).orderBy(desc(workObjectiveLoops.updatedAt)).limit(1);
    const actionsTruncated = actionRowsPlus.length > ACTION_LIMIT;
    const actionRows = actionRowsPlus.slice(0, ACTION_LIMIT);
    const actionIds = actionRows.map((row) => row.id);
    const effectRows = actionIds.length ? await db.select().from(businessEffects).where(and(eq(businessEffects.tenantId, tenantId), inArray(businessEffects.domainActionId, actionIds))).orderBy(asc(businessEffects.createdAt)) : [];
    const runIds = runRows.map((row) => row.id);
    const workOrActionsForDelivery = or(eq(communicationDeliveries.workId, workId), ...(actionIds.length ? [inArray(communicationDeliveries.domainActionId, actionIds)] : []));
    const workOrActionsForComputer = or(eq(computerRuns.workId, workId), ...(actionIds.length ? [inArray(computerRuns.domainActionId, actionIds)] : []));
    const deliveryRows = await db.select().from(communicationDeliveries).where(and(eq(communicationDeliveries.tenantId, tenantId), workOrActionsForDelivery)).orderBy(desc(communicationDeliveries.updatedAt));
    const computerRowsPlus = await db.select().from(computerRuns).where(and(eq(computerRuns.tenantId, tenantId), workOrActionsForComputer)).orderBy(desc(computerRuns.createdAt)).limit(COMPUTER_RUN_LIMIT + 1);
    const computerRows = computerRowsPlus.slice(0, COMPUTER_RUN_LIMIT);

    const stepRowsPlus = runIds.length === 0 ? [] : await db.select().from(workflowSteps)
      .where(and(eq(workflowSteps.tenantId, tenantId), inArray(workflowSteps.workflowRunId, runIds)))
      .orderBy(asc(workflowSteps.workflowRunId), asc(workflowSteps.sequence)).limit(WORKFLOW_STEP_LIMIT + 1);
    const workflowStepsTruncated = stepRowsPlus.length > WORKFLOW_STEP_LIMIT;
    const stepRows = stepRowsPlus.slice(0, WORKFLOW_STEP_LIMIT);
    const stepIds = stepRows.map((row) => row.id);

    const receiptWhere = or(
      eq(decisionReceipts.workId, workId),
      ...(actionIds.length ? [inArray(decisionReceipts.domainActionId, actionIds)] : []),
      ...(runIds.length ? [inArray(decisionReceipts.workflowRunId, runIds)] : []),
      ...(stepIds.length ? [inArray(decisionReceipts.workflowStepId, stepIds)] : []),
    );
    const receiptRows = await db.select().from(decisionReceipts).where(and(eq(decisionReceipts.tenantId, tenantId), receiptWhere)).orderBy(desc(decisionReceipts.createdAt));
    const decisionRows = await db.select().from(authorityDecisions).where(and(eq(authorityDecisions.tenantId, tenantId), or(eq(authorityDecisions.workId, workId), ...(actionIds.length ? [inArray(authorityDecisions.domainActionId, actionIds)] : [])))).orderBy(desc(authorityDecisions.createdAt));
    const approvalRows = actionIds.length ? await db.select().from(authorityApprovalRequests).where(and(eq(authorityApprovalRequests.tenantId, tenantId), inArray(authorityApprovalRequests.domainActionId, actionIds))).orderBy(desc(authorityApprovalRequests.createdAt)) : [];
    const integrationRows = stepIds.length ? await db.select().from(integrationOperations).where(and(eq(integrationOperations.tenantId, tenantId), inArray(integrationOperations.workflowStepId, stepIds))).orderBy(desc(integrationOperations.updatedAt)) : [];
    const externalRows = actionIds.length ? await db.select().from(externalOperations).where(and(eq(externalOperations.tenantId, tenantId), inArray(externalOperations.domainActionId, actionIds))).orderBy(desc(externalOperations.updatedAt)) : [];
    const reconRows = stepIds.length ? await db.select().from(reconciliationCases).where(and(eq(reconciliationCases.tenantId, tenantId), inArray(reconciliationCases.relatedStepId, stepIds))).orderBy(desc(reconciliationCases.createdAt)) : [];
    const compensationRows = stepIds.length ? await db.select().from(compensationCases).where(and(eq(compensationCases.tenantId, tenantId), inArray(compensationCases.workflowStepId, stepIds))).orderBy(desc(compensationCases.createdAt)) : [];
    const actionLogRows = actionIds.length ? await db.select().from(actionLog).where(and(eq(actionLog.tenantId, tenantId), inArray(actionLog.domainActionId, actionIds))).orderBy(desc(actionLog.timestamp)).limit(ACTION_LIMIT * 10) : [];
    const approvalIds = approvalRows.map((row) => row.id);
    const approvalStepRows = approvalIds.length ? await db.select().from(authorityApprovalRequestSteps)
      .where(and(eq(authorityApprovalRequestSteps.tenantId, tenantId), inArray(authorityApprovalRequestSteps.approvalRequestId, approvalIds)))
      .orderBy(asc(authorityApprovalRequestSteps.sequence)) : [];

    const computerRunIds = computerRows.map((row) => row.id);
    type ComputerStepWindowRow = {
      id: string; run_id: string; seq: number; phase: typeof computerSteps.$inferSelect.phase;
      operation: string; status: typeof computerSteps.$inferSelect.status; summary: string;
      created_at: Date | string; completed_at: Date | string | null; total_count: number | string;
    };
    const computerStepRows = computerRunIds.length ? (await db.execute<ComputerStepWindowRow>(sql`
      WITH ranked AS (
        SELECT cs.id, cs.run_id, cs.seq, cs.phase, cs.operation, cs.status, cs.summary,
               cs.created_at, cs.completed_at,
               count(*) OVER (PARTITION BY cs.run_id) AS total_count,
               row_number() OVER (PARTITION BY cs.run_id ORDER BY cs.seq DESC) AS row_number
        FROM finnor_os.computer_steps cs
        WHERE cs.tenant_id=${tenantId}::uuid
          AND cs.run_id IN (${sql.join(computerRunIds.map((id) => sql`${id}::uuid`), sql`, `)})
      )
      SELECT id, run_id, seq, phase, operation, status, summary, created_at, completed_at, total_count
      FROM ranked WHERE row_number <= ${COMPUTER_STEP_LIMIT}
      ORDER BY run_id, seq
    `)).rows : [];

    const employeeIds = [...new Set([
      viewer.userId,
      work.createdBy,
      work.currentOwnerId,
      ...actionRows.map((row) => row.initiatedBy),
      ...decisionRows.map((row) => row.employeeId),
      ...approvalStepRows.map((row) => row.decidedBy),
      ...computerRows.map((row) => row.actorId),
    ].filter((id): id is string => Boolean(id)))];
    const configuredIdentityIds = actionRows.map((row) => stringField(row.payload, "communicationIdentityId")).filter((id): id is string => typeof id === "string" && UUID_TEXT.test(id));
    const configuredAuthProfileRefs = actionRows.map((row) => stringField(row.payload, "authProfileRef")).filter((ref): ref is string => Boolean(ref));
    const identityIds = [...new Set([...deliveryRows.map((row) => row.communicationIdentityId).filter((id): id is string => Boolean(id)), ...configuredIdentityIds])];
    const accountIds = [...new Set(computerRows.map((row) => row.applicationAccountId))];
    const employeeRows = employeeIds.length ? await db.select({ id: users.id, displayName: users.displayName, role: users.role }).from(users).where(and(eq(users.tenantId, tenantId), inArray(users.id, employeeIds))) : [];
    const identityRows = identityIds.length ? await db.select({ id: communicationIdentities.id, identityKey: communicationIdentities.identityKey, channel: communicationIdentities.channel, provider: communicationIdentities.provider }).from(communicationIdentities).where(and(eq(communicationIdentities.tenantId, tenantId), inArray(communicationIdentities.id, identityIds))) : [];
    const accountRows = accountIds.length ? await db.select({ id: applicationAccounts.id, displayName: applicationAccounts.displayName, application: applicationAccounts.application, provider: applicationAccounts.provider }).from(applicationAccounts).where(and(eq(applicationAccounts.tenantId, tenantId), inArray(applicationAccounts.id, accountIds))) : [];
    const configuredProfileRows = configuredAuthProfileRefs.length ? await db.select({
        id: authProfiles.id,
        authProfileRef: authProfiles.authProfileRef,
        applicationAccountId: applicationAccounts.id,
        application: applicationAccounts.application,
        provider: applicationAccounts.provider,
        displayName: applicationAccounts.displayName,
      }).from(authProfiles).innerJoin(applicationAccounts, and(eq(applicationAccounts.tenantId, tenantId), eq(applicationAccounts.id, authProfiles.applicationAccountId)))
        .where(and(eq(authProfiles.tenantId, tenantId), inArray(authProfiles.authProfileRef, configuredAuthProfileRefs))) : [];

    const extractedRefs = new Map<string, { entityType: string; entityId: string; sourceRef: string }>();
    for (const link of linkRows) extractedRefs.set(`${link.entityType}:${link.entityId}`, { entityType: link.entityType, entityId: link.entityId, sourceRef: `work_entity_links:${link.id}` });
    for (const action of actionRows) collectTargetRefs(action.payload, extractedRefs, `domain_actions:${action.id}.payload`);
    const targetValues = [...extractedRefs.values()];
    const uuidTargetValues = targetValues.filter((target) => UUID_TEXT.test(target.entityId));
    const labelRows = uuidTargetValues.length ? (await db.execute<{ entity_type: string; entity_id: string; label: string | null; status: string | null }>(sql`
      WITH wanted(entity_type,entity_id) AS (VALUES ${sql.join(uuidTargetValues.map((target) => sql`(${target.entityType}::text,${target.entityId}::uuid)`), sql`, `)})
      SELECT n.entity_type,n.entity_id,n.label,n.status
      FROM finnor_os.company_graph_nodes n JOIN wanted w ON w.entity_type=n.entity_type AND w.entity_id=n.entity_id
      WHERE n.tenant_id=${tenantId}::uuid
    `)).rows : [];
    const labelByRef = new Map(labelRows.map((row) => [`${row.entity_type}:${row.entity_id}`, row]));
    const targetFor = (ref: { entityType: string; entityId: string; sourceRef: string }): ExecutionTarget => {
      const label = labelByRef.get(`${ref.entityType}:${ref.entityId}`);
      return { entityType: ref.entityType, entityId: ref.entityId, label: label?.label ?? null, status: label?.status ?? null, sourceRef: ref.sourceRef };
    };
    const targets = targetValues.map(targetFor).sort((a, b) => a.entityType.localeCompare(b.entityType) || a.entityId.localeCompare(b.entityId));

    const employeeById = new Map(employeeRows.map((row) => [row.id, row]));
    const identityById = new Map(identityRows.map((row) => [row.id, row]));
    const accountById = new Map(accountRows.map((row) => [row.id, row]));
    const configuredProfileByRef = new Map(configuredProfileRows.map((row) => [row.authProfileRef, row]));
    const actionById = new Map(actionRows.map((row) => [row.id, row]));
    const approvable = new Set(viewer.approvableActionIds ?? []);

    let evidenceTruncated = false;
    const projectedReceipts: ExecutionReceipt[] = receiptRows.map((receipt) => {
      const evidence = evidenceFrom(receipt.evidence, viewer.role);
      evidenceTruncated ||= evidence.truncated;
      const approval = record(receipt.approval);
      return {
        id: receipt.id,
        workId,
        domainActionId: receipt.domainActionId,
        workflowRunId: receipt.workflowRunId,
        workflowStepId: receipt.workflowStepId,
        businessEffectId: receipt.businessEffectId,
        intendedEffectHash: receipt.intendedEffectHash,
        authorizedEffectHash: receipt.authorizedEffectHash,
        executedEffectHash: receipt.executedEffectHash,
        effectVerification: receipt.verification as import("@finnor/shared-types").BusinessEffectVerification | null,
        recoveryEffectId: receipt.recoveryEffectId,
        objective: receipt.objective,
        policyApplied: receipt.policyApplied as { id: string; version: number } | null,
        riskTier: receipt.riskTier,
        approval: { required: approval.required === true, approvedBy: typeof approval.approvedBy === "string" ? approval.approvedBy : null, at: typeof approval.at === "string" ? approval.at : null },
        expectedResult: receipt.expectedResult ? sanitizeExecutionValue(receipt.expectedResult, viewer.role) as Record<string, unknown> : null,
        actualResult: receipt.actualResult ? sanitizeExecutionValue(receipt.actualResult, viewer.role) as Record<string, unknown> : null,
        evidence: evidence.rows,
        failure: failureFrom(receipt.failure, `decision_receipts:${receipt.id}`),
        finalizedAt: iso(receipt.finalizedAt),
        createdAt: receipt.createdAt.toISOString(),
        sourceRef: `decision_receipts:${receipt.id}`,
      };
    });
    const receiptsByAction = new Map<string, ExecutionReceipt[]>();
    for (const receipt of projectedReceipts) if (receipt.domainActionId) receiptsByAction.set(receipt.domainActionId, [...(receiptsByAction.get(receipt.domainActionId) ?? []), receipt]);

    const decisionsByAction = new Map<string, typeof decisionRows>();
    for (const decision of decisionRows) if (decision.domainActionId) decisionsByAction.set(decision.domainActionId, [...(decisionsByAction.get(decision.domainActionId) ?? []), decision]);
    const approvalsByAction = new Map(approvalRows.map((row) => [row.domainActionId, row]));
    const stepsByRun = new Map<string, typeof stepRows>();
    for (const step of stepRows) stepsByRun.set(step.workflowRunId, [...(stepsByRun.get(step.workflowRunId) ?? []), step]);
    const runIdsByAction = new Map<string, string[]>();
    for (const step of stepRows) if (step.domainActionId) runIdsByAction.set(step.domainActionId, [...new Set([...(runIdsByAction.get(step.domainActionId) ?? []), step.workflowRunId])]);
    const runById = new Map(runRows.map((row) => [row.id, row]));
    const integrationsByStep = new Map<string, typeof integrationRows>();
    for (const operation of integrationRows) integrationsByStep.set(operation.workflowStepId, [...(integrationsByStep.get(operation.workflowStepId) ?? []), operation]);
    const externalByAction = new Map<string, typeof externalRows>();
    for (const operation of externalRows) externalByAction.set(operation.domainActionId, [...(externalByAction.get(operation.domainActionId) ?? []), operation]);
    const reconByStep = new Map(reconRows.map((row) => [row.relatedStepId!, row]));
    const compensationByStep = new Map(compensationRows.map((row) => [row.workflowStepId, row]));
    const logsByAction = new Map<string, typeof actionLogRows>();
    for (const entry of actionLogRows) logsByAction.set(entry.domainActionId, [...(logsByAction.get(entry.domainActionId) ?? []), entry]);
    const deliveryByAction = new Map<string, typeof deliveryRows>();
    for (const delivery of deliveryRows) deliveryByAction.set(delivery.domainActionId, [...(deliveryByAction.get(delivery.domainActionId) ?? []), delivery]);
    const computerByAction = new Map(computerRows.map((row) => [row.domainActionId, row]));
    const effectByAction = new Map(effectRows.flatMap((row) => row.domainActionId ? [[row.domainActionId, row] as const] : []));

    let anyComputerTruncated = computerRowsPlus.length > COMPUTER_RUN_LIMIT;
    const projectComputer = (run: typeof computerRows[number]): ExecutionComputerRun => {
      const bounded = computerStepRows.filter((step) => step.run_id === run.id).sort((a, b) => a.seq - b.seq);
      const stepCount = Number(bounded[0]?.total_count ?? 0);
      const stepsTruncated = stepCount > COMPUTER_STEP_LIMIT;
      anyComputerTruncated ||= stepsTruncated;
      const actor = actorFrom(employeeById.get(run.actorId)) ?? { employeeId: run.actorId, displayName: null, role: null, sourceRef: `users:${run.actorId}` };
      const account = accountById.get(run.applicationAccountId);
      return {
        id: run.id,
        status: run.status,
        effectStatus: run.effectStatus,
        mode: run.mode,
        application: run.application,
        provider: run.provider,
        account: { id: run.applicationAccountId, label: account?.displayName ?? humanize(run.application) },
        actor,
        task: boundedString(run.task),
        target: run.target as { kind: string; identifier: string },
        currentActivity: bounded.at(-1)?.summary ?? null,
        steps: bounded.map((step) => ({ id: step.id, seq: step.seq, phase: step.phase, operation: step.operation, status: step.status, summary: boundedString(step.summary), createdAt: new Date(step.created_at).toISOString(), completedAt: iso(step.completed_at) })),
        stepCount,
        stepsTruncated,
        result: run.result ? sanitizeExecutionValue(run.result, viewer.role) as Record<string, unknown> : null,
        failureCode: run.failureCode,
        blockReason: run.blockReason ? boundedString(run.blockReason) : null,
        cancellationRequested: run.cancellationRequestedAt !== null,
        createdAt: run.createdAt.toISOString(),
        startedAt: iso(run.startedAt),
        finishedAt: iso(run.finishedAt),
        sourceRef: `computer_runs:${run.id}`,
      };
    };
    const projectedComputerByAction = new Map(computerRows.map((row) => [row.domainActionId, projectComputer(row)]));

    const projectedWorkflows: ExecutionWorkflow[] = runRows.map((run) => {
      const steps = (stepsByRun.get(run.id) ?? []).sort((a, b) => a.sequence - b.sequence);
      const unknown = steps.some((step) => (integrationsByStep.get(step.id) ?? []).some((operation) => operation.status === "unknown") || reconByStep.get(step.id)?.status === "open");
      return {
        id: run.id,
        workflowType: run.workflowType,
        status: run.status,
        version: run.version,
        actionIds: [...new Set(steps.map((step) => step.domainActionId).filter((id): id is string => Boolean(id)))],
        steps: steps.map((step) => {
          const integration = (integrationsByStep.get(step.id) ?? [])[0];
          const reconciliation = reconByStep.get(step.id);
          const compensation = compensationByStep.get(step.id);
          return {
            id: step.id,
            sequence: step.sequence,
            stepType: step.stepType,
            status: step.status,
            executionState: step.executionState,
            effectCommitAt: iso(step.effectCommitAt),
            cancellationRequestedAt: iso(step.cancellationRequestedAt),
            attempts: step.attempts,
            terminalReason: step.terminalReason ? boundedString(step.terminalReason) : null,
            domainActionId: step.domainActionId,
            integration: integration ? { capability: integration.capability, provider: integration.provider, status: integration.status, sourceRef: `integration_operations:${integration.id}` } : null,
            reconciliation: reconciliation ? { caseId: reconciliation.id, status: reconciliation.status, sourceRef: `reconciliation_cases:${reconciliation.id}` } : null,
            compensation: compensation ? { caseId: compensation.id, status: compensation.status, sourceRef: `compensation_cases:${compensation.id}` } : null,
            controls: viewer.canControlRuns === true && step.status === "completed" && COMPENSATABLE_STEPS.has(step.stepType) && integration?.status === "succeeded" && !reconciliation && !compensation
              ? [{ kind: "compensate", label: "Compensate", endpoint: `/api/workflows/steps/${step.id}/compensate`, method: "POST", expectedVersion: null, reason: "This completed effect has a registered typed compensation binding." }]
              : [],
            updatedAt: step.updatedAt.toISOString(),
            sourceRef: `workflow_steps:${step.id}`,
          };
        }),
        controls: workflowControls(run.status, run.id, run.version, viewer.canControlRuns === true && !isRetiredWaterWorkflow(run.workflowType), unknown),
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
        sourceRef: `workflow_runs:${run.id}`,
      };
    });

    const nodeShells = actionRows.map((action) => {
      const receipts = receiptsByAction.get(action.id) ?? [];
      const receipt = receipts[0] ?? null;
      const decisions = decisionsByAction.get(action.id) ?? [];
      const decision = decisions.find((row) => row.operation === "execution")
        ?? decisions.find((row) => row.operation === "durable_operation")
        ?? decisions.find((row) => row.operation !== "approval")
        ?? null;
      const approvalRow = approvalsByAction.get(action.id);
      const approvalSteps = approvalRow ? approvalStepRows.filter((step) => step.approvalRequestId === approvalRow.id) : [];
      const latestApprovalStep = approvalSteps.filter((step) => step.decidedAt).sort((a, b) => (b.decidedAt?.getTime() ?? 0) - (a.decidedAt?.getTime() ?? 0))[0];
      const dependencyRows = action.dependsOn.map((id) => actionById.get(id)).filter((row): row is typeof actionRows[number] => Boolean(row));
      const actionRunIds = runIdsByAction.get(action.id) ?? [];
      const actionRuns = actionRunIds.map((id) => runById.get(id)).filter((row): row is typeof runRows[number] => Boolean(row));
      const actionSteps = actionRuns.flatMap((run) => stepsByRun.get(run.id) ?? []).filter((step) => !step.domainActionId || step.domainActionId === action.id);
      const actionIntegrations = actionSteps.flatMap((step) => integrationsByStep.get(step.id) ?? []);
      const actionRecon = actionSteps.map((step) => reconByStep.get(step.id)).filter(Boolean);
      const ext = externalByAction.get(action.id) ?? [];
      const deliveries = deliveryByAction.get(action.id) ?? [];
      const computer = projectedComputerByAction.get(action.id) ?? null;
      const actionLogs = logsByAction.get(action.id) ?? [];
      const effect = effectByAction.get(action.id) ?? null;
      const unknown = ext.some((row) => row.status === "unknown") || actionIntegrations.some((row) => row.status === "unknown") || deliveries.some((row) => row.status === "unknown") || actionRecon.some((row) => row?.status === "open") || computer?.effectStatus === "unknown";
      const reconciling = actionRecon.some((row) => row?.status === "open") || computer?.status === "reconciling";
      const workflowFailed = actionRuns.some((run) => ["failed", "cancelled", "escalated"].includes(run.status));
      const workflowOpen = actionRuns.some((run) => !["completed", "compensated", "failed", "cancelled", "escalated"].includes(run.status));
      let verification: ExecutionVerificationState;
      let verificationBasis: string;
      if (reconciling) { verification = "reconciling"; verificationBasis = "An open durable reconciliation case is attached to this execution."; }
      else if (unknown) { verification = "unknown"; verificationBasis = "A persisted external operation has an unknown outcome."; }
      else if (computer) {
        if (computer.status === "succeeded" && computer.result) { verification = "verified"; verificationBasis = "The persisted computer run reached succeeded with a bounded result."; }
        else if (["blocked", "failed", "timed_out", "cancelled"].includes(computer.status)) { verification = "failed"; verificationBasis = `The persisted computer run is ${computer.status}.`; }
        else { verification = "awaiting_observation"; verificationBasis = `The persisted computer run is ${computer.status}.`; }
      } else if (workflowFailed || receipt?.failure) { verification = "failed"; verificationBasis = workflowFailed ? "A linked workflow reached a non-success terminal state." : "The canonical receipt contains a failure."; }
      else if (workflowOpen) { verification = "awaiting_observation"; verificationBasis = "A linked durable workflow has not reached a successful terminal state."; }
      else if (action.status === "completed" && receipt?.finalizedAt && receipt.actualResult && !receipt.failure) { verification = "verified"; verificationBasis = "A finalized canonical receipt contains the observed actual result."; }
      else if (["failed", "rejected", "needs_human_review", "blocked_integration_unavailable"].includes(action.status)) { verification = "failed"; verificationBasis = `The DomainAction is ${action.status}.`; }
      else if (["executing", "completed"].includes(action.status)) { verification = "awaiting_observation"; verificationBasis = "No finalized actual result has verified the business outcome yet."; }
      else { verification = "not_started"; verificationBasis = "The action has not begun execution."; }

      const authorityState: ExecutionAuthority["state"] = !decision ? "unknown"
        : decision.outcome === "denied" && decision.operation === "execution" && action.authorityRevision !== null && decision.authorityRevision !== action.authorityRevision ? "authority_changed"
          : decision.outcome === "denied" ? "denied"
            : decision.outcome === "approval_required" ? "approval_required"
              : action.status === "needs_human_review" && decision.operation === "execution" ? "reauthorization_required" : "allowed";
      const authority: ExecutionAuthority = {
        state: authorityState,
        decisionId: decision?.id ?? action.authorityDecisionId,
        revision: decision?.authorityRevision ?? action.authorityRevision,
        operation: decision?.operation ?? null,
        outcome: decision?.outcome ?? null,
        risk: decision?.risk ?? null,
        reasonCode: decision?.reasonCode ?? (typeof record(action.authorityContext).reasonCode === "string" ? String(record(action.authorityContext).reasonCode) : null),
        employeeId: decision?.employeeId ?? action.initiatedBy,
        sourceRef: decision ? `authority_decisions:${decision.id}` : action.authorityDecisionId ? `domain_actions:${action.id}.authority_decision_id` : null,
      };
      const approvalRequired = Boolean(approvalRow) || authority.outcome === "approval_required" || action.status === "pending";
      const approval: ExecutionApproval = {
        required: approvalRequired,
        status: approvalRow?.status ?? (approvalRequired ? "unknown" : "not_required"),
        requestId: approvalRow?.id ?? null,
        currentStep: approvalRow?.currentStep ?? null,
        totalSteps: approvalSteps.length,
        decidedBy: latestApprovalStep?.decidedBy ? actorFrom(employeeById.get(latestApprovalStep.decidedBy)) : null,
        decidedAt: iso(latestApprovalStep?.decidedAt),
        consequence: action.summary ?? humanize(action.actionType),
        sourceRef: approvalRow ? `authority_approval_requests:${approvalRow.id}` : null,
      };

      const actionTargets = [...collectTargetRefs(action.payload).values()].map(targetFor);
      const delivery = deliveries[0];
      const identity = delivery?.communicationIdentityId ? identityById.get(delivery.communicationIdentityId) : null;
      const configuredIdentityId = stringField(action.payload, "communicationIdentityId");
      const configuredIdentity = configuredIdentityId ? identityById.get(configuredIdentityId) : null;
      const configuredProfileRef = stringField(action.payload, "authProfileRef");
      const configuredProfile = configuredProfileRef ? configuredProfileByRef.get(configuredProfileRef) : null;
      const integration = actionIntegrations[0];
      const external = ext[0];
      let route: ExecutionProviderRoute | null = null;
      if (computer) route = { application: computer.application, provider: computer.provider, identity: { kind: "application_account", id: computer.account.id, label: computer.account.label, channel: null }, route: "computer", source: "persisted_execution", sourceRef: computer.sourceRef };
      else if (delivery) route = { application: delivery.channel === "internal" ? "FINNOR" : humanize(delivery.channel), provider: delivery.provider, identity: identity ? { kind: "communication_identity", id: identity.id, label: identity.identityKey, channel: identity.channel } : null, route: delivery.route, source: "persisted_execution", sourceRef: `communication_deliveries:${delivery.id}` };
      else if (integration) route = { application: humanize(integration.capability), provider: integration.provider, identity: null, route: "workflow", source: "persisted_execution", sourceRef: `integration_operations:${integration.id}` };
      else if (external?.provider) route = { application: null, provider: external.provider, identity: null, route: "api", source: "persisted_execution", sourceRef: `external_operations:${external.domainActionId}:${external.operationKey}` };
      else if (configuredIdentity) route = { application: humanize(configuredIdentity.channel), provider: configuredIdentity.provider, identity: { kind: "communication_identity", id: configuredIdentity.id, label: configuredIdentity.identityKey, channel: configuredIdentity.channel }, route: null, source: "persisted_configuration", sourceRef: `communication_identities:${configuredIdentity.id}` };
      else if (configuredProfile) route = { application: configuredProfile.application, provider: configuredProfile.provider, identity: { kind: "application_account", id: configuredProfile.applicationAccountId, label: configuredProfile.displayName, channel: null }, route: null, source: "persisted_configuration", sourceRef: `auth_profiles:${configuredProfile.id}` };
      else if (actionRuns.length) route = { application: "FINNOR workflow runtime", provider: null, identity: null, route: "workflow", source: "persisted_execution", sourceRef: `workflow_runs:${actionRuns[0]!.id}` };

      let failure = receipt?.failure ?? null;
      if (!failure) {
        const failureLog = actionLogs.find((entry) => {
          const output = record(entry.output);
          return Boolean(failureFrom(output, `action_log:${entry.id}`)) || ["failed", "blocked", "timed_out", "cancelled"].includes(String(output.status ?? ""));
        });
        if (failureLog) {
          const output = record(failureLog.output);
          failure = failureFrom(output, `action_log:${failureLog.id}`);
          if (!failure) {
            const status = String(output.status ?? "failed");
            const reason = typeof output.reason === "string" ? output.reason : typeof output.error === "string" ? output.error : typeof output.code === "string" ? output.code : `Execution recorded ${status}`;
            failure = {
              errorKind: status === "blocked" ? "needs_human" : status === "timed_out" ? "unknown_outcome" : "terminal",
              message: boundedString(reason),
              recoveryPath: null,
              reconciliationRequired: status === "timed_out",
              retrySafe: false,
              humanRequired: true,
              sourceRef: `action_log:${failureLog.id}`,
            };
          }
        }
      }
      if (!failure && computer && ["blocked", "failed", "timed_out", "cancelled"].includes(computer.status)) failure = {
        errorKind: computer.status === "blocked" ? "needs_human" : computer.status === "timed_out" ? "unknown_outcome" : "terminal",
        message: computer.blockReason ?? computer.failureCode ?? `Computer run ${computer.status}`,
        recoveryPath: computer.status === "blocked" ? "Resolve the recorded block before starting another governed attempt." : null,
        reconciliationRequired: computer.effectStatus === "unknown" || computer.status === "timed_out",
        retrySafe: false,
        humanRequired: true,
        sourceRef: computer.sourceRef,
      };
      if (!failure && action.status === "blocked_integration_unavailable") failure = { errorKind: "provider_down", message: "The required integration was unavailable; no completed effect is confirmed.", recoveryPath: "Review provider health, then use a legal workflow recovery transition if one is available.", reconciliationRequired: unknown, retrySafe: !unknown, humanRequired: unknown, sourceRef: `domain_actions:${action.id}.status` };
      if (!failure && action.status === "needs_human_review") failure = { errorKind: authorityState === "authority_changed" ? "auth" : "needs_human", message: authority.reasonCode ? `Human review required: ${humanize(authority.reasonCode)}.` : "This action requires human review before another effect.", recoveryPath: "Review authority, approval, and existing evidence before deciding.", reconciliationRequired: unknown, retrySafe: false, humanRequired: true, sourceRef: authority.sourceRef ?? `domain_actions:${action.id}.status` };
      if (!failure && action.status === "failed") failure = { errorKind: "terminal", message: "The DomainAction is failed; no normalized failure receipt or action-log detail was recorded.", recoveryPath: null, reconciliationRequired: unknown, retrySafe: false, humanRequired: true, sourceRef: `domain_actions:${action.id}.status` };
      if (failure && unknown) failure = { ...failure, reconciliationRequired: true, retrySafe: false };

      const predicted = record(record(record(action.predictedReceipt).simulation).predicted).expectedResult;
      const expected = receipt?.expectedResult ?? (predicted && typeof predicted === "object" && !Array.isArray(predicted) ? sanitizeExecutionValue(predicted, viewer.role) as Record<string, unknown> : null);
      const controls: ExecutionControl[] = [];
      const retiredHistoricalAction = isRetiredWaterAction(action.actionType);
      if (!retiredHistoricalAction && approvable.has(action.id) && action.status === "pending") {
        controls.push(
          { kind: "approve", label: "Approve", endpoint: `/api/actions/${action.id}/confirm`, method: "POST", expectedVersion: null, reason: "This exact pending consequence may be approved by the current employee." },
          { kind: "reject", label: "Reject", endpoint: `/api/actions/${action.id}/reject`, method: "POST", expectedVersion: null, reason: "This exact pending consequence may be rejected by the current employee." },
          { kind: "escalate", label: "Escalate", endpoint: `/api/actions/${action.id}/escalate`, method: "POST", expectedVersion: null, reason: "Pending actions may be escalated for additional review." },
        );
      } else if (!retiredHistoricalAction && approvable.has(action.id) && action.status === "needs_human_review") {
        controls.push(
          { kind: "approve", label: "Reauthorize", endpoint: `/api/actions/${action.id}/confirm`, method: "POST", expectedVersion: null, reason: "The backend will re-evaluate current authority before any effect." },
          { kind: "reject", label: "Reject", endpoint: `/api/actions/${action.id}/reject`, method: "POST", expectedVersion: null, reason: "Reject this exact reviewed consequence." },
        );
      }
      if (!retiredHistoricalAction && computer && !["succeeded", "blocked", "failed", "timed_out", "cancelled"].includes(computer.status) && (computer.actor.employeeId === viewer.userId || viewer.canCancelComputer)) {
        controls.push({ kind: "cancel", label: "Cancel computer task", endpoint: `/api/computer/runs/${computer.id}/cancel`, method: "POST", expectedVersion: null, reason: "The worker will stop before its next primitive and preserve completed evidence." });
      }

      const externalEffect: ExecutionActionNode["externalEffect"] = unknown ? "unknown"
        : computer?.effectStatus === "succeeded" || deliveries.some((row) => ["sent", "delivered"].includes(row.status)) || ext.some((row) => row.status === "succeeded") || actionIntegrations.some((row) => row.status === "succeeded") ? "confirmed"
          : action.status === "executing" || ext.some((row) => row.status === "running") || actionIntegrations.some((row) => row.status === "running") ? "pending"
            : action.status === "failed" && (ext.length > 0 || actionIntegrations.length > 0) ? "possible" : "none";

      return {
        action,
        verification,
        effectExecutionStates: actionSteps.map((step) => step.executionState),
        node: {
          id: action.id,
          planId: action.planId,
          actionType: action.actionType,
          businessVerb: humanize(action.actionType),
          summary: action.summary,
          sourceStatus: action.status,
          status: "waiting_dependency" as ExecutionActionNode["status"],
          semanticPayload: sanitizeExecutionValue(
            effect ? (effect.effect as import("@finnor/shared-types").BusinessEffectSet).delta.values : action.payload,
            viewer.role,
          ) as Record<string, unknown>,
          businessEffect: effect ? {
            id: effect.id,
            semanticHash: effect.semanticHash,
            scopeHash: effect.scopeHash,
            status: effect.status,
            contract: sanitizeExecutionValue(effect.effect, viewer.role) as unknown as import("@finnor/shared-types").BusinessEffectSet,
            verification: effect.verification as import("@finnor/shared-types").BusinessEffectVerification | null,
            sourceRef: `business_effects:${effect.id}`,
          } : null,
          targets: actionTargets,
          dependencyIds: action.dependsOn,
          dependentIds: [] as string[],
          blockedBy: dependencyRows.filter((row) => row.status !== "completed").map((row) => ({ actionId: row.id, status: row.status })),
          actor: actorFrom(action.initiatedBy ? employeeById.get(action.initiatedBy) : undefined),
          route,
          authority,
          approval,
          intent: { expectedResult: expected, source: receipt?.expectedResult ? "receipt" as const : expected ? "prediction" as const : "none" as const },
          observation: { actualResult: receipt?.actualResult ?? computer?.result ?? null, evidence: receipt?.evidence ?? [], verification, basis: verificationBasis },
          externalEffect,
          failure,
          workflowRunIds: actionRunIds,
          receiptIds: receipts.map((row) => row.id),
          computer,
          controls,
          timestamps: { createdAt: action.createdAt.toISOString(), executionStartedAt: iso(action.executionStartedAt), lastChangedAt: receipt?.finalizedAt ?? computer?.finishedAt ?? computer?.startedAt ?? action.createdAt.toISOString() },
          sourceRefs: [`domain_actions:${action.id}`, ...(effect ? [`business_effects:${effect.id}`] : []), ...(receipt ? [receipt.sourceRef] : []), ...(authority.sourceRef ? [authority.sourceRef] : []), ...(route ? [route.sourceRef] : [])],
        } satisfies ExecutionActionNode,
      };
    });

    const dependents = new Map<string, string[]>();
    for (const shell of nodeShells) for (const dependencyId of shell.action.dependsOn) dependents.set(dependencyId, [...(dependents.get(dependencyId) ?? []), shell.action.id]);
    for (const shell of nodeShells) {
      shell.node.dependentIds = dependents.get(shell.action.id) ?? [];
      shell.node.status = deriveExecutionNodeStatus({
        sourceStatus: shell.action.status,
        dependencyStatuses: shell.action.dependsOn.map((id) => actionById.get(id)?.status).filter((status): status is DomainActionStatus => Boolean(status)),
        verification: shell.verification,
        authorityState: shell.node.authority.state,
        computerStatus: shell.node.computer?.status,
        effectExecutionStates: shell.effectExecutionStates,
      });
    }
    const nodes = nodeShells.map((shell) => shell.node);
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const edges: ExecutionDependencyEdge[] = nodes.flatMap((node) => node.dependencyIds.map((fromActionId) => ({
      fromActionId,
      toActionId: node.id,
      state: edgeState(nodeById.get(fromActionId)?.status ?? "waiting_dependency"),
      sourceRef: `domain_actions:${node.id}.depends_on`,
    })));

    const workFailure = failureFrom(work.failure, `works:${work.id}.failure`);
    const objective = objectiveRows[0]?.objective ?? work.initialInstruction;
    return {
      version: 1,
      work: {
        id: work.id,
        status: work.status,
        executionModel: work.executionModel,
        objective,
        objectiveState: objectiveRows[0]?.state ?? null,
        successCondition: objectiveRows[0]?.successCondition as ExecutionProjection["work"]["successCondition"] ?? null,
        successVerification: objectiveRows[0]?.successVerification as ExecutionProjection["work"]["successVerification"] ?? null,
        successVerifiedAt: objectiveRows[0]?.successVerifiedAt?.toISOString() ?? null,
        createdAt: work.createdAt.toISOString(),
        updatedAt: work.updatedAt.toISOString(),
        finalOutcome: work.finalOutcome ? sanitizeExecutionValue(work.finalOutcome, viewer.role) as Record<string, unknown> : null,
        failure: workFailure,
      },
      targets,
      nodes,
      edges,
      workflows: projectedWorkflows,
      receipts: projectedReceipts,
      viewer: { role: viewer.role, evidenceVisibility: "full" },
      limits: { actions: ACTION_LIMIT, workflowSteps: WORKFLOW_STEP_LIMIT, computerStepsPerRun: COMPUTER_STEP_LIMIT, evidencePerReceipt: EVIDENCE_LIMIT },
      truncated: { actions: actionsTruncated, workflowSteps: workflowStepsTruncated, computerSteps: anyComputerTruncated, evidence: evidenceTruncated },
      asOf: new Date().toISOString(),
    };
  }, viewer.userId);
}
