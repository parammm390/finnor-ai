import {
  actionLog,
  approvalChains,
  approvalChainSteps,
  authorityApprovalRequests,
  authorityApprovalRequestSteps,
  authorityDecisions,
  authorityStates,
  businessEffects,
  domainActions,
  employeeRoleAssignments,
  employeeRoles,
  roleAuthorityGrants,
  rolePermissions,
  users,
  withTenant,
  works,
  type Db,
} from "@finnor/db";
import type {
  AuthorityDecision,
  AuthorityRequest,
  AuthorityResource,
  AuthorityRisk,
  Role,
  TenantContext,
} from "@finnor/shared-types";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RISK_RANK: Record<AuthorityRisk, number> = { low: 1, medium: 2, high: 3 };

type Scope =
  | { kind: "tenant" }
  | { kind: "resources"; resourceType?: string; resourceIds?: string[] }
  | { kind: "assigned" }
  | { kind: "self" };

type Assignment = {
  roleId: string;
  roleKey: string;
  scope: Scope;
};

type Grant = {
  id: string;
  roleId: string;
  capability: string;
  resourceType: string;
  effect: "allow" | "deny";
  maxAmountUsd: string | null;
  maxRisk: AuthorityRisk;
  approvalRequired: boolean;
  approvalChainId: string | null;
};

type LoadedAuthority = {
  revision: number;
  employee: { id: string; status: "active" | "suspended"; role: Role } | null;
  assignments: Assignment[];
  grants: Grant[];
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function scope(value: unknown): Scope {
  const raw = record(value);
  if (raw.kind === "resources") return {
    kind: "resources",
    ...(typeof raw.resourceType === "string" ? { resourceType: raw.resourceType } : {}),
    resourceIds: Array.isArray(raw.resourceIds) ? raw.resourceIds.filter((id): id is string => typeof id === "string" && UUID.test(id)) : [],
  };
  if (raw.kind === "assigned" || raw.kind === "self") return { kind: raw.kind };
  return { kind: "tenant" };
}

function capabilityMatches(grant: string, requested: string): boolean {
  if (grant === "*") return true;
  if (grant === requested) return true;
  if (grant.endsWith(":*") && requested.startsWith(grant.slice(0, -1))) return true;
  return false;
}

function resourceTypeMatches(grant: string, requested: string): boolean {
  return grant === "*" || requested === "*" || grant === requested;
}

function normalizeResources(request: AuthorityRequest): AuthorityResource[] {
  const rows = [...(request.resource ? [request.resource] : []), ...(request.resources ?? [])];
  if (rows.length === 0) return [{ type: "*" }];
  return [...new Map(rows.map((row) => [`${row.type}:${row.id ?? "*"}`, row])).values()];
}

async function isAssigned(db: Db, tenantId: string, employeeId: string, resource: AuthorityResource): Promise<boolean> {
  if (resource.type === "user" || resource.type === "employee") return resource.id === employeeId;
  if (!resource.id) return false;
  if (resource.type === "work") {
    const [row] = await db.select({ id: works.id }).from(works).where(and(eq(works.tenantId, tenantId), eq(works.id, resource.id), or(eq(works.assignedTo, employeeId), eq(works.currentOwnerId, employeeId)))).limit(1);
    return Boolean(row);
  }
  return false;
}

async function scopeAllows(db: Db, tenantId: string, employeeId: string, assignment: Assignment, resource: AuthorityResource): Promise<boolean> {
  if (assignment.scope.kind === "tenant") return true;
  if (assignment.scope.kind === "resources") {
    if (!resource.id) return false;
    if (assignment.scope.resourceType && assignment.scope.resourceType !== "*" && assignment.scope.resourceType !== resource.type) return false;
    return Boolean(assignment.scope.resourceIds?.includes(resource.id));
  }
  if (assignment.scope.kind === "self") {
    if (!resource.id) return false;
    return (resource.type === "user" || resource.type === "employee") && resource.id === employeeId;
  }
  return isAssigned(db, tenantId, employeeId, resource);
}

async function everyResourceAllows(
  resources: AuthorityResource[],
  predicate: (resource: AuthorityResource) => Promise<boolean>,
): Promise<boolean> {
  // withTenant supplies one transaction-scoped pg client. Keep its reads serial:
  // pg clients cannot execute overlapping queries on the same connection.
  for (const resource of resources) {
    if (!await predicate(resource)) return false;
  }
  return true;
}

async function loadAuthorities(db: Db, tenantId: string, employeeIds: string[]): Promise<Map<string, LoadedAuthority>> {
  const uniqueEmployeeIds = [...new Set(employeeIds)];
  const [state] = await db.select({ revision: authorityStates.revision }).from(authorityStates).where(eq(authorityStates.tenantId, tenantId)).limit(1);
  if (uniqueEmployeeIds.length === 0) return new Map();
  const employees = await db.select({ id: users.id, status: users.status, role: users.role }).from(users).where(and(eq(users.tenantId, tenantId), inArray(users.id, uniqueEmployeeIds)));
  const assignmentsWithEmployee = await db.select({ employeeId: employeeRoleAssignments.employeeId, roleId: employeeRoleAssignments.roleId, roleKey: employeeRoles.key, resourceScope: employeeRoleAssignments.resourceScope })
    .from(employeeRoleAssignments)
    .innerJoin(employeeRoles, and(eq(employeeRoles.id, employeeRoleAssignments.roleId), eq(employeeRoles.tenantId, tenantId), eq(employeeRoles.active, true)))
    .where(and(
      eq(employeeRoleAssignments.tenantId, tenantId),
      inArray(employeeRoleAssignments.employeeId, uniqueEmployeeIds),
      eq(employeeRoleAssignments.active, true),
      lte(employeeRoleAssignments.effectiveFrom, new Date()),
      or(isNull(employeeRoleAssignments.expiresAt), sql`${employeeRoleAssignments.expiresAt} > now()`),
    ));
  const roleIds = [...new Set(assignmentsWithEmployee.map((row) => row.roleId))];
  const grantRows = roleIds.length === 0 ? [] : await db.select().from(roleAuthorityGrants).where(and(eq(roleAuthorityGrants.tenantId, tenantId), inArray(roleAuthorityGrants.roleId, roleIds)));
  const grants: Grant[] = grantRows.map((row) => ({
      id: row.id,
      roleId: row.roleId,
      capability: row.capability,
      resourceType: row.resourceType,
      effect: row.effect,
      maxAmountUsd: row.maxAmountUsd,
      maxRisk: row.maxRisk,
      approvalRequired: row.approvalRequired,
      approvalChainId: row.approvalChainId,
    }));
  const employeeById = new Map(employees.map((employee) => [employee.id, employee] as const));
  return new Map(uniqueEmployeeIds.map((employeeId) => {
    const employee = employeeById.get(employeeId);
    const assignments = assignmentsWithEmployee
      .filter((row) => row.employeeId === employeeId)
      .map((row) => ({ roleId: row.roleId, roleKey: row.roleKey, scope: scope(row.resourceScope) }));
    const employeeRoleIds = new Set(assignments.map((assignment) => assignment.roleId));
    return [employeeId, {
      revision: state?.revision ?? 1,
      employee: employee?.role === "owner" ? { id: employee.id, status: employee.status, role: "owner" as const } : null,
      assignments,
      grants: grants.filter((grant) => employeeRoleIds.has(grant.roleId)),
    }] as const;
  }));
}

async function loadAuthority(db: Db, tenantId: string, employeeId: string): Promise<LoadedAuthority> {
  const authorities = await loadAuthorities(db, tenantId, [employeeId]);
  return authorities.get(employeeId) ?? { revision: 1, employee: null, assignments: [], grants: [] };
}

async function eligibleApproversTx(
  db: Db,
  tenantId: string,
  chainId: string,
  actionType: string,
  resources: AuthorityResource[],
): Promise<string[]> {
  const [step] = await db.select().from(approvalChainSteps).where(and(eq(approvalChainSteps.tenantId, tenantId), eq(approvalChainSteps.approvalChainId, chainId), eq(approvalChainSteps.sequence, 1))).limit(1);
  if (!step) return [];
  const capability = step.approverCapability.replaceAll("$action", actionType);
  const candidates = await db.select({ id: users.id }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.status, "active")));
  const authorities = await loadAuthorities(db, tenantId, candidates.map((candidate) => candidate.id));
  const eligible: string[] = [];
  for (const candidate of candidates) {
    const auth = authorities.get(candidate.id);
    if (!auth?.employee || auth.employee.status !== "active") continue;
    const matching = auth.grants.filter((grant) => capabilityMatches(grant.capability, capability) && grant.effect === "allow");
    let allowed = false;
    for (const grant of matching) {
      const assignment = auth.assignments.find((row) => row.roleId === grant.roleId);
      if (!assignment) continue;
      const everyResource = await everyResourceAllows(resources, async (resource) => (
        resourceTypeMatches(grant.resourceType, resource.type)
        && await scopeAllows(db, tenantId, candidate.id, assignment, resource)
      ));
      if (everyResource) { allowed = true; break; }
    }
    if (allowed) eligible.push(candidate.id);
  }
  return eligible;
}

function decisionShape(row: typeof authorityDecisions.$inferSelect, eligibleApproverIds: string[]): AuthorityDecision {
  return {
    id: row.id,
    tenantId: row.tenantId,
    employeeId: row.employeeId,
    authorityRevision: row.authorityRevision,
    operation: row.operation,
    capability: row.capability,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    amountUsd: row.amountUsd === null ? null : Number(row.amountUsd),
    risk: row.risk,
    outcome: row.outcome,
    reasonCode: row.reasonCode,
    approvalChainId: row.approvalChainId,
    eligibleApproverIds,
    evidence: record(row.evidence),
    businessEffectId: row.businessEffectId,
    businessEffectHash: row.businessEffectHash,
  };
}

async function insertDecision(db: Db, params: {
  ctx: TenantContext;
  request: AuthorityRequest;
  employeeId: string | null;
  revision: number;
  outcome: AuthorityDecision["outcome"];
  reasonCode: string;
  chainId?: string | null;
  eligibleApproverIds?: string[];
  evidence: Record<string, unknown>;
}): Promise<AuthorityDecision> {
  const resources = normalizeResources(params.request);
  const first = resources[0] ?? { type: "*" };
  const [row] = await db.insert(authorityDecisions).values({
    tenantId: params.ctx.tenantId,
    employeeId: params.employeeId,
    authorityRevision: params.revision,
    operation: params.request.operation,
    capability: params.request.capability,
    resourceType: first.type,
    resourceId: first.id && UUID.test(first.id) ? first.id : null,
    amountUsd: params.request.amountUsd === undefined ? null : String(params.request.amountUsd),
    risk: params.request.risk,
    outcome: params.outcome,
    reasonCode: params.reasonCode,
    approvalChainId: params.chainId ?? null,
    evidence: { ...params.evidence, resources, eligibleApproverIds: params.eligibleApproverIds ?? [] },
    workId: params.request.workId && UUID.test(params.request.workId) ? params.request.workId : null,
    domainActionId: params.request.domainActionId && UUID.test(params.request.domainActionId) ? params.request.domainActionId : null,
    operationId: params.request.operationId && UUID.test(params.request.operationId) ? params.request.operationId : null,
    businessEffectId: params.request.businessEffectId && UUID.test(params.request.businessEffectId) ? params.request.businessEffectId : null,
    businessEffectHash: params.request.businessEffectHash ?? null,
  }).returning();
  return decisionShape(row!, params.eligibleApproverIds ?? []);
}

/** Deterministic, fail-closed authority evaluation. The result and exact grant/scope
 * evidence are appended in the same tenant transaction. */
export async function evaluateAuthority(ctx: TenantContext, request: AuthorityRequest): Promise<AuthorityDecision> {
  return withTenant(ctx.tenantId, async (db) => {
    const employeeId = ctx.employeeId ?? (UUID.test(ctx.userId) ? ctx.userId : null);
    // Service principals are explicit and never synthesized from a human role.
    if (!employeeId) {
      const [state] = await db.select({ revision: authorityStates.revision }).from(authorityStates).where(eq(authorityStates.tenantId, ctx.tenantId)).limit(1);
      const revision = state?.revision ?? 1;
      const trustedService = ctx.userId.startsWith("system:");
      if (trustedService) return insertDecision(db, { ctx, request, employeeId: null, revision, outcome: "allowed", reasonCode: "trusted_service_principal", evidence: { principal: ctx.userId } });
      // Integration-test/dev headers predate canonical employees. Keep this strictly
      // outside production; bearer-authenticated production requests never enter it.
      if (process.env.NODE_ENV !== "production") {
        let allowed = request.operation !== "approval";
        if (request.operation === "approval") {
          const actionType = request.capability.replace(/^approve:/, "");
          const permissions = await db.select({ actionType: rolePermissions.actionType, canApprove: rolePermissions.canApprove }).from(rolePermissions).where(and(
            eq(rolePermissions.tenantId, ctx.tenantId),
            eq(rolePermissions.role, ctx.role),
            or(eq(rolePermissions.actionType, actionType), eq(rolePermissions.actionType, "*")),
          ));
          const permission = permissions.find((row) => row.actionType === actionType) ?? permissions.find((row) => row.actionType === "*");
          allowed = permission?.canApprove ?? ctx.role === "owner";
        }
        return insertDecision(db, { ctx, request, employeeId: null, revision, outcome: allowed ? (request.policyRequiresApproval ? "approval_required" : "allowed") : "denied", reasonCode: allowed ? "legacy_dev_context" : "approval_capability_missing", evidence: { legacyRole: ctx.role, nonProduction: true } });
      }
      return insertDecision(db, { ctx, request, employeeId: null, revision, outcome: "denied", reasonCode: "canonical_employee_required", evidence: {} });
    }

    const auth = await loadAuthority(db, ctx.tenantId, employeeId);
    if (!auth.employee) {
      if (process.env.NODE_ENV !== "production") {
        let allowed = request.operation !== "approval";
        if (request.operation === "approval") {
          const actionType = request.capability.replace(/^approve:/, "");
          const permissions = await db.select({ actionType: rolePermissions.actionType, canApprove: rolePermissions.canApprove }).from(rolePermissions).where(and(
            eq(rolePermissions.tenantId, ctx.tenantId),
            eq(rolePermissions.role, ctx.role),
            or(eq(rolePermissions.actionType, actionType), eq(rolePermissions.actionType, "*")),
          ));
          const permission = permissions.find((row) => row.actionType === actionType) ?? permissions.find((row) => row.actionType === "*");
          allowed = permission?.canApprove ?? ctx.role === "owner";
        }
        return insertDecision(db, { ctx, request, employeeId: null, revision: auth.revision, outcome: allowed ? "allowed" : "denied", reasonCode: allowed ? "legacy_dev_context" : "approval_capability_missing", evidence: { legacyRole: ctx.role, nonProduction: true } });
      }
      return insertDecision(db, { ctx, request, employeeId: null, revision: auth.revision, outcome: "denied", reasonCode: "employee_not_found", evidence: {} });
    }
    if (auth.employee.status !== "active") return insertDecision(db, { ctx, request, employeeId, revision: auth.revision, outcome: "denied", reasonCode: "employee_suspended", evidence: { status: auth.employee.status } });

    const resources = normalizeResources(request);
    const candidates = auth.grants.filter((grant) => capabilityMatches(grant.capability, request.capability));
    const evaluated: Array<{ grant: Grant; assignment: Assignment; scopeAllowed: boolean; typeAllowed: boolean; amountAllowed: boolean; riskAllowed: boolean }> = [];
    for (const grant of candidates) {
      const assignment = auth.assignments.find((row) => row.roleId === grant.roleId);
      if (!assignment) continue;
      const typeAllowed = resources.every((resource) => resourceTypeMatches(grant.resourceType, resource.type));
      const scopeAllowed = typeAllowed && await everyResourceAllows(
        resources,
        (resource) => scopeAllows(db, ctx.tenantId, employeeId, assignment, resource),
      );
      const amountAllowed = request.amountUsd === undefined || grant.maxAmountUsd === null || request.amountUsd <= Number(grant.maxAmountUsd);
      const riskAllowed = RISK_RANK[request.risk] <= RISK_RANK[grant.maxRisk];
      evaluated.push({ grant, assignment, scopeAllowed, typeAllowed, amountAllowed, riskAllowed });
    }
    const evidence = {
      roles: auth.assignments.map((row) => row.roleKey),
      evaluatedGrantIds: evaluated.map((row) => row.grant.id),
      matchedScopes: evaluated.filter((row) => row.scopeAllowed).map((row) => ({ grantId: row.grant.id, roleId: row.grant.roleId, scope: row.assignment.scope })),
      requestedAmountUsd: request.amountUsd ?? null,
      requestedRisk: request.risk,
    };
    if (evaluated.some((row) => row.grant.effect === "deny" && row.scopeAllowed)) {
      return insertDecision(db, { ctx, request, employeeId, revision: auth.revision, outcome: "denied", reasonCode: "explicit_deny", evidence });
    }
    const allows = evaluated.filter((row) => row.grant.effect === "allow" && row.scopeAllowed);
    if (allows.length === 0) {
      const reasonCode = candidates.length === 0 ? "capability_missing" : evaluated.some((row) => row.typeAllowed) ? "resource_out_of_scope" : "resource_type_not_granted";
      return insertDecision(db, { ctx, request, employeeId, revision: auth.revision, outcome: "denied", reasonCode, evidence });
    }
    const withinLimits = allows.filter((row) => row.amountAllowed && row.riskAllowed);
    if (withinLimits.length === 0) {
      const reasonCode = allows.some((row) => !row.amountAllowed) ? "monetary_limit_exceeded" : "risk_limit_exceeded";
      const chain = allows.find((row) => row.grant.approvalChainId)?.grant.approvalChainId ?? null;
      // A configured chain can elevate a limit breach; absent one, fail closed.
      if (!chain) return insertDecision(db, { ctx, request, employeeId, revision: auth.revision, outcome: "denied", reasonCode, evidence });
      const eligible = await eligibleApproversTx(db, ctx.tenantId, chain, request.capability.replace(/^action:/, ""), resources);
      if (eligible.length === 0) return insertDecision(db, { ctx, request, employeeId, revision: auth.revision, outcome: "denied", reasonCode: "no_authorized_approver", chainId: chain, evidence: { ...evidence, limitReason: reasonCode } });
      return insertDecision(db, { ctx, request, employeeId, revision: auth.revision, outcome: "approval_required", reasonCode, chainId: chain, eligibleApproverIds: eligible, evidence });
    }
    const chosen = withinLimits[0]!;
    const requiresApproval = request.policyRequiresApproval === true || chosen.grant.approvalRequired;
    if (!requiresApproval) return insertDecision(db, { ctx, request, employeeId, revision: auth.revision, outcome: "allowed", reasonCode: "grant_allows", evidence: { ...evidence, selectedGrantId: chosen.grant.id } });
    const chain = chosen.grant.approvalChainId;
    if (!chain) return insertDecision(db, { ctx, request, employeeId, revision: auth.revision, outcome: "denied", reasonCode: "approval_chain_missing", evidence });
    const eligible = await eligibleApproversTx(db, ctx.tenantId, chain, request.capability.replace(/^action:/, ""), resources);
    if (eligible.length === 0) return insertDecision(db, { ctx, request, employeeId, revision: auth.revision, outcome: "denied", reasonCode: "no_authorized_approver", chainId: chain, evidence });
    return insertDecision(db, { ctx, request, employeeId, revision: auth.revision, outcome: "approval_required", reasonCode: request.policyRequiresApproval ? "policy_requires_approval" : "grant_requires_approval", chainId: chain, eligibleApproverIds: eligible, evidence: { ...evidence, selectedGrantId: chosen.grant.id } });
  });
}

export async function recordActionAuthority(params: {
  ctx: TenantContext;
  actionId: string;
  request: AuthorityRequest;
  decision: AuthorityDecision;
}): Promise<void> {
  await withTenant(params.ctx.tenantId, async (db) => {
    const context = {
      decisionId: params.decision.id,
      revision: params.decision.authorityRevision,
      outcome: params.decision.outcome,
      reasonCode: params.decision.reasonCode,
      capability: params.request.capability,
      risk: params.request.risk,
      amountUsd: params.request.amountUsd ?? null,
      resources: normalizeResources(params.request),
      approvalChainId: params.decision.approvalChainId,
      eligibleApproverIds: params.decision.eligibleApproverIds,
      businessEffectId: params.request.businessEffectId ?? null,
      businessEffectHash: params.request.businessEffectHash ?? null,
    };
    await db.update(domainActions).set({
      initiatedBy: params.decision.employeeId,
      authorityDecisionId: params.decision.id,
      authorityRevision: params.decision.authorityRevision,
      authorityContext: context,
    }).where(and(eq(domainActions.tenantId, params.ctx.tenantId), eq(domainActions.id, params.actionId)));
    await db.insert(actionLog).values({
      tenantId: params.ctx.tenantId,
      domainActionId: params.actionId,
      step: "authority_evaluated",
      input: { employeeId: params.decision.employeeId, capability: params.request.capability, revision: params.decision.authorityRevision },
      output: context,
    });
    if (params.decision.outcome !== "approval_required" || !params.decision.approvalChainId) return;
    const [approvalRequest] = await db.insert(authorityApprovalRequests).values({
      tenantId: params.ctx.tenantId,
      domainActionId: params.actionId,
      requesterId: params.decision.employeeId,
      authorityDecisionId: params.decision.id,
      approvalChainId: params.decision.approvalChainId,
      businessEffectId: params.request.businessEffectId ?? null,
      businessEffectHash: params.request.businessEffectHash ?? null,
    }).onConflictDoNothing({ target: authorityApprovalRequests.domainActionId }).returning();
    if (!approvalRequest) return;
    const steps = await db.select().from(approvalChainSteps).where(and(eq(approvalChainSteps.tenantId, params.ctx.tenantId), eq(approvalChainSteps.approvalChainId, params.decision.approvalChainId))).orderBy(approvalChainSteps.sequence);
    if (steps.length === 0) throw new Error("Authority approval chain has no steps");
    await db.insert(authorityApprovalRequestSteps).values(steps.map((step) => ({
      tenantId: params.ctx.tenantId,
      approvalRequestId: approvalRequest.id,
      sequence: step.sequence,
      approverCapability: step.approverCapability.replaceAll("$action", params.request.capability.replace(/^action:/, "")),
      minApprovals: step.minApprovals,
    })));
  });
}

export async function evaluateActionApproval(ctx: TenantContext, actionId: string): Promise<AuthorityDecision> {
  const [row] = await withTenant(ctx.tenantId, (db) => db.select({
    actionType: domainActions.actionType,
    workId: domainActions.workId,
    authorityContext: domainActions.authorityContext,
    requestId: authorityApprovalRequests.id,
    requestStatus: authorityApprovalRequests.status,
    currentStep: authorityApprovalRequests.currentStep,
    stepCapability: authorityApprovalRequestSteps.approverCapability,
    businessEffectId: domainActions.businessEffectId,
    requestBusinessEffectId: authorityApprovalRequests.businessEffectId,
    requestBusinessEffectHash: authorityApprovalRequests.businessEffectHash,
    effectSemanticHash: businessEffects.semanticHash,
  }).from(domainActions)
    .leftJoin(authorityApprovalRequests, and(eq(authorityApprovalRequests.domainActionId, domainActions.id), eq(authorityApprovalRequests.tenantId, ctx.tenantId)))
    .leftJoin(authorityApprovalRequestSteps, and(eq(authorityApprovalRequestSteps.approvalRequestId, authorityApprovalRequests.id), eq(authorityApprovalRequestSteps.sequence, authorityApprovalRequests.currentStep)))
    .leftJoin(businessEffects, and(eq(businessEffects.id, domainActions.businessEffectId), eq(businessEffects.tenantId, ctx.tenantId)))
    .where(and(eq(domainActions.tenantId, ctx.tenantId), eq(domainActions.id, actionId))).limit(1));
  if (!row) throw new Error("Action not found");
  const context = record(row.authorityContext);
  const resources = Array.isArray(context.resources) ? context.resources.filter((item): item is AuthorityResource => Boolean(item && typeof item === "object" && typeof (item as AuthorityResource).type === "string")) : [];
  const request: AuthorityRequest = {
    operation: "approval",
    capability: row.stepCapability ?? `approve:${row.actionType}`,
    resources,
    amountUsd: typeof context.amountUsd === "number" ? context.amountUsd : undefined,
    risk: context.risk === "low" || context.risk === "high" ? context.risk : "medium",
    workId: row.workId ?? undefined,
    domainActionId: actionId,
    businessEffectId: row.businessEffectId ?? undefined,
    businessEffectHash: row.effectSemanticHash ?? undefined,
  };
  if (row.businessEffectId && (!row.effectSemanticHash || (row.requestId && (row.requestBusinessEffectId !== row.businessEffectId || row.requestBusinessEffectHash !== row.effectSemanticHash)))) {
    return withTenant(ctx.tenantId, (db) => insertDecision(db, {
      ctx,
      request,
      employeeId: ctx.employeeId ?? (UUID.test(ctx.userId) ? ctx.userId : null),
      revision: 1,
      outcome: "denied",
      reasonCode: "business_effect_approval_mismatch",
      evidence: { actionBusinessEffectId: row.businessEffectId, requestBusinessEffectId: row.requestBusinessEffectId, requestBusinessEffectHash: row.requestBusinessEffectHash, currentEffectHash: row.effectSemanticHash },
    }));
  }
  return evaluateAuthority(ctx, request);
}

export async function finalizeApprovalAuthorityTx(db: Db, params: {
  tenantId: string;
  actionId: string;
  decision: "approve" | "reject";
  approverId: string;
  authorityDecisionId: string;
}): Promise<void> {
    const [request] = await db.select().from(authorityApprovalRequests).where(and(eq(authorityApprovalRequests.tenantId, params.tenantId), eq(authorityApprovalRequests.domainActionId, params.actionId))).limit(1);
    if (!request || request.status !== "pending") return;
    const [step] = await db.update(authorityApprovalRequestSteps).set({
      status: params.decision === "approve" ? "approved" : "rejected",
      decidedBy: params.approverId,
      authorityDecisionId: params.authorityDecisionId,
      decidedAt: new Date(),
    }).where(and(eq(authorityApprovalRequestSteps.approvalRequestId, request.id), eq(authorityApprovalRequestSteps.sequence, request.currentStep), eq(authorityApprovalRequestSteps.status, "pending"))).returning();
    if (!step) return;
    if (params.decision === "reject") {
      await db.update(authorityApprovalRequests).set({ status: "rejected", resolvedAt: new Date() }).where(eq(authorityApprovalRequests.id, request.id));
      return;
    }
    const [next] = await db.select().from(authorityApprovalRequestSteps).where(and(eq(authorityApprovalRequestSteps.approvalRequestId, request.id), eq(authorityApprovalRequestSteps.sequence, request.currentStep + 1))).limit(1);
    await db.update(authorityApprovalRequests).set(next ? { currentStep: request.currentStep + 1 } : { status: "approved", resolvedAt: new Date() }).where(eq(authorityApprovalRequests.id, request.id));
}

export async function finalizeApprovalAuthority(params: Parameters<typeof finalizeApprovalAuthorityTx>[1]): Promise<void> {
  await withTenant(params.tenantId, (db) => finalizeApprovalAuthorityTx(db, params));
}

export async function isFinalApprovalStep(tenantId: string, actionId: string): Promise<boolean> {
  return withTenant(tenantId, async (db) => {
    const [request] = await db.select({ id: authorityApprovalRequests.id, currentStep: authorityApprovalRequests.currentStep }).from(authorityApprovalRequests).where(and(eq(authorityApprovalRequests.tenantId, tenantId), eq(authorityApprovalRequests.domainActionId, actionId), eq(authorityApprovalRequests.status, "pending"))).limit(1);
    if (!request) return true;
    const [next] = await db.select({ id: authorityApprovalRequestSteps.id }).from(authorityApprovalRequestSteps).where(and(eq(authorityApprovalRequestSteps.approvalRequestId, request.id), eq(authorityApprovalRequestSteps.sequence, request.currentStep + 1))).limit(1);
    return !next;
  });
}

export async function employeeAuthoritySnapshot(ctx: TenantContext): Promise<{ employeeId: string; revision: number; roles: string[] }> {
  const employeeId = ctx.employeeId ?? ctx.userId;
  if (!UUID.test(employeeId)) throw new Error("Canonical employee identity is required");
  return withTenant(ctx.tenantId, async (db) => {
    const auth = await loadAuthority(db, ctx.tenantId, employeeId);
    if (!auth.employee || auth.employee.status !== "active") throw new Error("Employee identity is not active");
    return { employeeId, revision: auth.revision, roles: auth.assignments.map((row) => row.roleKey) };
  });
}

/** Read-only counterpart to evaluateAuthority for projection/control discovery.
 * It deliberately appends no authority decision: GET read models may reveal only
 * controls the current employee can exercise, without turning a read into history.
 * Mutation routes still call evaluateAuthority and remain the final authorizer. */
export async function canExerciseAuthority(ctx: TenantContext, request: AuthorityRequest): Promise<boolean> {
  return withTenant(ctx.tenantId, async (db) => {
    const employeeId = ctx.employeeId ?? (UUID.test(ctx.userId) ? ctx.userId : null);
    const legacyApprovalAllowed = async (): Promise<boolean> => {
      if (process.env.NODE_ENV === "production" || request.operation !== "approval") return false;
      const actionType = request.capability.replace(/^approve:/, "");
      const permissions = await db.select({ actionType: rolePermissions.actionType, canApprove: rolePermissions.canApprove }).from(rolePermissions).where(and(
        eq(rolePermissions.tenantId, ctx.tenantId),
        eq(rolePermissions.role, ctx.role),
        or(eq(rolePermissions.actionType, actionType), eq(rolePermissions.actionType, "*")),
      ));
      const permission = permissions.find((row) => row.actionType === actionType) ?? permissions.find((row) => row.actionType === "*");
      return permission?.canApprove ?? ctx.role === "owner";
    };
    if (!employeeId) return legacyApprovalAllowed();

    const auth = await loadAuthority(db, ctx.tenantId, employeeId);
    if (!auth.employee) return legacyApprovalAllowed();
    if (auth.employee.status !== "active") return false;

    const resources = normalizeResources(request);
    const candidates = auth.grants.filter((grant) => capabilityMatches(grant.capability, request.capability));
    const evaluated: Array<{ grant: Grant; scopeAllowed: boolean; amountAllowed: boolean; riskAllowed: boolean }> = [];
    for (const grant of candidates) {
      const assignment = auth.assignments.find((row) => row.roleId === grant.roleId);
      if (!assignment) continue;
      const typeAllowed = resources.every((resource) => resourceTypeMatches(grant.resourceType, resource.type));
      const scopeAllowed = typeAllowed && await everyResourceAllows(
        resources,
        (resource) => scopeAllows(db, ctx.tenantId, employeeId, assignment, resource),
      );
      evaluated.push({
        grant,
        scopeAllowed,
        amountAllowed: request.amountUsd === undefined || grant.maxAmountUsd === null || request.amountUsd <= Number(grant.maxAmountUsd),
        riskAllowed: RISK_RANK[request.risk] <= RISK_RANK[grant.maxRisk],
      });
    }
    if (evaluated.some((row) => row.grant.effect === "deny" && row.scopeAllowed)) return false;
    const chosen = evaluated.find((row) => row.grant.effect === "allow" && row.scopeAllowed && row.amountAllowed && row.riskAllowed);
    if (!chosen) return false;
    return request.policyRequiresApproval !== true && chosen.grant.approvalRequired !== true;
  });
}

export async function eligibleApproversForActions(tenantId: string, actionIds: string[]): Promise<Record<string, string[]>> {
  const uniqueActionIds = [...new Set(actionIds)];
  if (uniqueActionIds.length === 0) return {};
  return withTenant(tenantId, async (db) => {
    const actions = await db.select({ id: domainActions.id, actionType: domainActions.actionType, authorityContext: domainActions.authorityContext })
      .from(domainActions)
      .where(and(eq(domainActions.tenantId, tenantId), inArray(domainActions.id, uniqueActionIds)));
    const requests = await db.select({ id: authorityApprovalRequests.id, domainActionId: authorityApprovalRequests.domainActionId, currentStep: authorityApprovalRequests.currentStep })
      .from(authorityApprovalRequests)
      .where(and(
        eq(authorityApprovalRequests.tenantId, tenantId),
        eq(authorityApprovalRequests.status, "pending"),
        inArray(authorityApprovalRequests.domainActionId, uniqueActionIds),
      ));
    const requestIds = requests.map((request) => request.id);
    const steps = requestIds.length === 0 ? [] : await db.select({ approvalRequestId: authorityApprovalRequestSteps.approvalRequestId, sequence: authorityApprovalRequestSteps.sequence, approverCapability: authorityApprovalRequestSteps.approverCapability })
      .from(authorityApprovalRequestSteps)
      .where(and(eq(authorityApprovalRequestSteps.tenantId, tenantId), inArray(authorityApprovalRequestSteps.approvalRequestId, requestIds)));
    const candidates = await db.select({ id: users.id }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.status, "active")));
    const authorities = await loadAuthorities(db, tenantId, candidates.map((candidate) => candidate.id));
    const requestByActionId = new Map(requests.map((request) => [request.domainActionId, request] as const));
    const stepByRequestId = new Map(steps.map((step) => [`${step.approvalRequestId}:${step.sequence}`, step] as const));
    const scopeCache = new Map<string, boolean>();
    const result: Record<string, string[]> = Object.fromEntries(uniqueActionIds.map((actionId) => [actionId, []]));

    for (const action of actions) {
      const request = requestByActionId.get(action.id);
      const step = request ? stepByRequestId.get(`${request.id}:${request.currentStep}`) : undefined;
      if (!step) continue;
      const capability = step.approverCapability.replaceAll("$action", action.actionType);
      const context = record(action.authorityContext);
      const resources = Array.isArray(context.resources) ? context.resources as AuthorityResource[] : [{ type: "*" }];
      for (const candidate of candidates) {
        const auth = authorities.get(candidate.id);
        if (!auth?.employee || auth.employee.status !== "active") continue;
        const matching = auth.grants.filter((grant) => capabilityMatches(grant.capability, capability) && grant.effect === "allow");
        let allowed = false;
        for (const grant of matching) {
          const assignment = auth.assignments.find((row) => row.roleId === grant.roleId);
          if (!assignment) continue;
          const everyResource = await everyResourceAllows(resources, async (resource) => {
            if (!resourceTypeMatches(grant.resourceType, resource.type)) return false;
            const cacheKey = `${candidate.id}:${assignment.roleId}:${resource.type}:${resource.id ?? "*"}`;
            if (scopeCache.has(cacheKey)) return scopeCache.get(cacheKey)!;
            const scopeAllowed = await scopeAllows(db, tenantId, candidate.id, assignment, resource);
            scopeCache.set(cacheKey, scopeAllowed);
            return scopeAllowed;
          });
          if (everyResource) { allowed = true; break; }
        }
        if (allowed) result[action.id]!.push(candidate.id);
      }
    }
    return result;
  });
}

export async function eligibleApproversForAction(tenantId: string, actionId: string): Promise<string[]> {
  const eligible = await eligibleApproversForActions(tenantId, [actionId]);
  return eligible[actionId] ?? [];
}

/** Used by durable workers immediately before effects. It rejects stale/revoked
 * initiator authority even when an earlier approval decision was valid. */
export async function revalidateActionExecution(tenantId: string, actionId: string, operation: "execution" | "durable_operation" = "execution", operationId?: string): Promise<AuthorityDecision> {
  const [loaded] = await withTenant(tenantId, (db) => db
    .select({ action: domainActions, effect: businessEffects })
    .from(domainActions)
    .leftJoin(businessEffects, and(eq(businessEffects.tenantId, tenantId), eq(businessEffects.id, domainActions.businessEffectId)))
    .where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, actionId)))
    .limit(1));
  const action = loaded?.action;
  if (!action) throw new Error("Action not found");
  const context = record(action.authorityContext);
  const employeeId = action.initiatedBy;
  const ctx: TenantContext = !employeeId
    ? { tenantId, userId: "system:durable-runtime", role: "owner" }
    : { tenantId, userId: employeeId, employeeId, role: "owner" };
  const request: AuthorityRequest = {
      operation,
      capability: `action:${action.actionType}`,
      risk: context.risk === "low" || context.risk === "high" ? context.risk : "medium",
      resources: Array.isArray(context.resources) ? context.resources as AuthorityResource[] : [],
      amountUsd: typeof context.amountUsd === "number" ? context.amountUsd : undefined,
      workId: action.workId ?? undefined,
      domainActionId: action.id,
      operationId,
      businessEffectId: action.businessEffectId ?? undefined,
      businessEffectHash: loaded.effect?.semanticHash,
    };
  // `failed` means the provider returned a known negative outcome and may enter the
  // existing one-shot retry policy. Unknown/reconciliation/divergent effects remain
  // excluded and therefore fail closed before any repeat mutation.
  if (action.businessEffectId && (!loaded.effect || !["authorized", "executing", "failed", "partially_verified", "verified"].includes(loaded.effect.status))) {
    return withTenant(tenantId, (db) => insertDecision(db, {
      ctx,
      request,
      employeeId,
      revision: action.authorityRevision ?? 1,
      outcome: "denied",
      reasonCode: "business_effect_not_authorized",
      evidence: { businessEffectId: action.businessEffectId, effectStatus: loaded.effect?.status ?? null },
    }));
  }
  const decision = await evaluateAuthority(ctx, request);
  if (decision.outcome === "denied") return decision;
  const originallyRequiredApproval = context.outcome === "approval_required" || decision.outcome === "approval_required";
  if (!originallyRequiredApproval) return decision;
  return withTenant(tenantId, async (db) => {
    const [approval] = await db.select({ id: authorityApprovalRequests.id, status: authorityApprovalRequests.status, businessEffectId: authorityApprovalRequests.businessEffectId, businessEffectHash: authorityApprovalRequests.businessEffectHash }).from(authorityApprovalRequests).where(and(eq(authorityApprovalRequests.tenantId, tenantId), eq(authorityApprovalRequests.domainActionId, actionId))).limit(1);
    if (action.businessEffectId && (approval?.businessEffectId !== action.businessEffectId || approval.businessEffectHash !== loaded.effect?.semanticHash)) {
      return insertDecision(db, {
        ctx,
        request,
        employeeId,
        revision: decision.authorityRevision,
        outcome: "denied",
        reasonCode: "authorized_business_effect_mismatch",
        evidence: { priorDecisionId: decision.id, approvalRequestId: approval?.id ?? null, actionBusinessEffectId: action.businessEffectId, approvalBusinessEffectId: approval?.businessEffectId ?? null },
      });
    }
    if (approval?.status !== "approved") {
      if (decision.outcome === "approval_required") return decision;
      return insertDecision(db, {
        ctx,
        request,
        employeeId,
        revision: decision.authorityRevision,
        outcome: "denied",
        reasonCode: "required_approval_not_complete",
        evidence: { priorDecisionId: decision.id, approvalRequestId: approval?.id ?? null, approvalStatus: approval?.status ?? null },
      });
    }
    return insertDecision(db, {
      ctx,
      request,
      employeeId,
      revision: decision.authorityRevision,
      outcome: "allowed",
      reasonCode: "approved_authority_chain",
      evidence: { priorDecisionId: decision.id, approvalRequestId: approval.id },
    });
  });
}
