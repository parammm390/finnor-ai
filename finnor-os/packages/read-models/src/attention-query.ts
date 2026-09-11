import {
  canExerciseAuthority,
  eligibleApproversForActions,
  employeeAuthoritySnapshot,
} from "@finnor/authority";
import {
  resolveTenantVertical,
  withTenant,
} from "@finnor/db";
import {
  OPERATIONAL_QUERY_VERSION,
  PRIVATE_EQUITY_VERTICAL,
  type AttentionActor,
  type AttentionAuthorityBoundary,
  type AttentionCausalRef,
  type AttentionEvidenceRef,
  type AttentionHumanBoundary,
  type AttentionImpact,
  type AttentionItem,
  type AttentionKind,
  type AttentionQueueRequest,
  type AttentionQueueResult,
  type AttentionRecoveryBoundary,
  type AttentionRootRef,
  type AttentionSourceStatus,
  type TenantContext,
} from "@finnor/shared-types";
import { sql } from "drizzle-orm";
import type { OperationalQueryOptions } from "./operational-queries";
import { buildAttentionRankVector, compareAttentionItems } from "./attention-ranking";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const OPEN_WORK_STATES = [
  "received", "understanding", "planning", "ready", "actionable", "awaiting_approval",
  "executing", "waiting", "blocked", "recovery", "failed",
] as const;
const OPEN_WORK_SQL = sql.join(OPEN_WORK_STATES.map((state) => sql`${state}`), sql`, `);

type SourceName = AttentionSourceStatus["sources"][number]["source"];
type SourceState = AttentionSourceStatus["sources"][number];
type Row = Record<string, unknown>;
type DraftAttentionItem = Omit<AttentionItem, "rankVector" | "slackMs" | "rankReason">;

interface SourceRead<T> {
  name: SourceName;
  tables: string[];
  available: boolean;
  rows: T;
  errorCode?: string;
}

interface ActivePlan {
  id: string;
  workId: string;
  graphHash: string;
  graph: {
    nodes: Array<{ id: string; kind: string; dependsOn?: string[] }>;
    edges: Array<{ from: string; to: string }>;
    completionCoverage: Array<{ criterionId: string; checkNodeId: string }>;
  };
}

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.valueOf())) throw new Error("Canonical attention timestamp is invalid");
  return date.toISOString();
}

function boolean(value: unknown): boolean {
  return value === true || value === "true";
}

function rows(result: unknown): Row[] {
  const value = result as { rows?: unknown[] };
  return Array.isArray(value?.rows) ? value.rows.filter((row): row is Row => Boolean(row && typeof row === "object")) : [];
}

function sourceLimit(limit: number): number {
  return Math.min(400, Math.max(100, limit * 4));
}

function pageLimit(request: AttentionQueueRequest, options: OperationalQueryOptions): number {
  const raw = options.maxRows ?? request.page?.limit ?? DEFAULT_LIMIT;
  if (!Number.isFinite(raw) || raw < 1) throw new Error("Attention queue limit must be positive");
  return Math.min(MAX_LIMIT, Math.floor(raw));
}

async function readSource<T>(
  name: SourceName,
  tables: string[],
  reader: () => Promise<T>,
  empty: T,
): Promise<SourceRead<T>> {
  try {
    return { name, tables: [...tables].sort(), available: true, rows: await reader() };
  } catch {
    return { name, tables: [...tables].sort(), available: false, rows: empty, errorCode: "CANONICAL_SOURCE_READ_FAILED" };
  }
}

function parseGraph(value: unknown): ActivePlan["graph"] {
  const graph = record(value);
  const graphNodes = Array.isArray(graph.nodes) ? graph.nodes.map(record).flatMap((node) => {
    const id = nullableText(node.id);
    const kind = nullableText(node.kind);
    if (!id || !kind) return [];
    return [{ id, kind, dependsOn: Array.isArray(node.dependsOn) ? node.dependsOn.filter((item): item is string => typeof item === "string") : [] }];
  }) : [];
  const graphEdges = Array.isArray(graph.edges) ? graph.edges.map(record).flatMap((edge) => {
    const from = nullableText(edge.from);
    const to = nullableText(edge.to);
    return from && to ? [{ from, to }] : [];
  }) : [];
  const completionCoverage = Array.isArray(graph.completionCoverage) ? graph.completionCoverage.map(record).flatMap((coverage) => {
    const criterionId = nullableText(coverage.criterionId);
    const checkNodeId = nullableText(coverage.checkNodeId);
    return criterionId && checkNodeId ? [{ criterionId, checkNodeId }] : [];
  }) : [];
  return { nodes: graphNodes, edges: graphEdges, completionCoverage };
}

function exactPlanImpact(plan: ActivePlan | undefined, nodeId: string | null): {
  impact: AttentionImpact;
  blocked: AttentionCausalRef[];
  unblocks: AttentionCausalRef[];
  evidence: AttentionEvidenceRef[];
} {
  const empty: AttentionImpact = {
    blocksWorkCompletion: false,
    downstreamPlanNodes: 0,
    completionCriteria: 0,
    sourceBackedMateriality: null,
  };
  if (!plan || !nodeId || !plan.graph.nodes.some((node) => node.id === nodeId)) {
    return { impact: empty, blocked: [], unblocks: [], evidence: [] };
  }
  const outgoing = new Map<string, string[]>();
  for (const edge of plan.graph.edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  for (const node of plan.graph.nodes) {
    for (const parent of node.dependsOn ?? []) outgoing.set(parent, [...(outgoing.get(parent) ?? []), node.id]);
  }
  const descendants = new Set<string>();
  const frontier = [...new Set(outgoing.get(nodeId) ?? [])].sort();
  while (frontier.length > 0) {
    const current = frontier.shift()!;
    if (descendants.has(current)) continue;
    descendants.add(current);
    frontier.push(...(outgoing.get(current) ?? []).filter((id) => !descendants.has(id)).sort());
  }
  const criteria = plan.graph.completionCoverage
    .filter((coverage) => coverage.checkNodeId === nodeId || descendants.has(coverage.checkNodeId))
    .sort((left, right) => left.criterionId.localeCompare(right.criterionId));
  const blocksWorkCompletion = criteria.length > 0;
  return {
    impact: {
      blocksWorkCompletion,
      downstreamPlanNodes: descendants.size,
      completionCriteria: criteria.length,
      sourceBackedMateriality: null,
    },
    blocked: [{ kind: "plan_node", id: nodeId }],
    unblocks: [
      ...[...descendants].sort().map((id): AttentionCausalRef => ({ kind: "plan_node", id })),
      ...criteria.map((coverage): AttentionCausalRef => ({ kind: "goal_criterion", id: coverage.criterionId })),
      ...(blocksWorkCompletion ? [{ kind: "work_completion" as const, id: plan.workId }] : []),
    ],
    evidence: [{ type: "work_plan_revision", id: plan.id, hash: plan.graphHash }],
  };
}

function workActor(row: Row, employeeId: string): AttentionActor | null {
  if (row.assigned_to === employeeId) return { employeeId, basis: "work_assignment", capability: null };
  if (row.current_owner_id === employeeId) return { employeeId, basis: "work_owner", capability: null };
  return null;
}

function rootRef(type: string, id: string, source: string): AttentionRootRef {
  return { entityType: type, entityId: id, relationship: "about", source };
}

function sortedUniqueEvidence(values: AttentionEvidenceRef[]): AttentionEvidenceRef[] {
  return [...new Map(values.map((value) => [`${value.type}:${value.id}:${value.hash ?? ""}`, value])).values()]
    .sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`));
}

function sortedUniqueRoots(values: AttentionRootRef[]): AttentionRootRef[] {
  return [...new Map(values.map((value) => [`${value.entityType}:${value.entityId}:${value.relationship}`, value])).values()]
    .sort((left, right) => `${left.entityType}:${left.entityId}`.localeCompare(`${right.entityType}:${right.entityId}`));
}

function rankReason(item: DraftAttentionItem, vector: AttentionItem["rankVector"]): AttentionItem["rankReason"] {
  const primary = vector.safetyRecoveryRank === 0
    ? "Recovery or terminal-failure boundary"
    : vector.deadlineRank === 0
      ? "Explicit deadline is overdue"
      : vector.downstreamCompletionCriteria > 0
        ? "Blocks verified completion criteria"
        : vector.downstreamPlanNodes > 0
          ? "Blocks downstream Plan nodes"
          : vector.authorityBottleneckRank === 0
            ? "Required human or authority boundary"
            : "Explicit Work ownership or assignment";
  const factors = [
    `safetyRecovery=${vector.safetyRecoveryRank === 0 ? "yes" : "no"}`,
    `deadline=${vector.slackMs === null ? "none" : vector.slackMs <= 0 ? "overdue" : "active"}`,
    `completionCriteria=${vector.downstreamCompletionCriteria}`,
    `downstreamPlanNodes=${vector.downstreamPlanNodes}`,
    `authorityBottleneck=${vector.authorityBottleneckRank === 0 ? "yes" : "no"}`,
    `materiality=${item.impact.sourceBackedMateriality?.classification ?? "not_provided"}`,
    `ageMs=${vector.ageMs}`,
    `tieBreak=${vector.stableTieBreak}`,
  ];
  return { primary, factors };
}

function baseDraft(input: {
  id: string;
  workId: string;
  kind: AttentionKind;
  reason: string;
  actor: AttentionActor;
  createdAt: string;
  deadline?: string | null;
  plan?: ActivePlan;
  planNodeId?: string | null;
  roots?: AttentionRootRef[];
  evidence?: AttentionEvidenceRef[];
  authorityBoundary?: AttentionAuthorityBoundary | null;
  recoveryBoundary?: AttentionRecoveryBoundary | null;
  humanBoundary: AttentionHumanBoundary;
  directBlocks?: AttentionCausalRef[];
  directUnblocks?: AttentionCausalRef[];
  directImpact?: Partial<AttentionImpact>;
}): DraftAttentionItem {
  const planImpact = exactPlanImpact(input.plan, input.planNodeId ?? null);
  const impact: AttentionImpact = {
    ...planImpact.impact,
    ...(input.directImpact ?? {}),
  };
  return {
    id: input.id,
    workId: input.workId,
    ...(input.plan ? { planRevisionId: input.plan.id } : {}),
    ...(input.planNodeId ? { planNodeId: input.planNodeId } : {}),
    rootRefs: sortedUniqueRoots([rootRef("work", input.workId, "works"), ...(input.roots ?? [])]),
    kind: input.kind,
    reason: input.reason,
    assignedOrEligibleActor: input.actor,
    deadline: input.deadline ?? null,
    blocks: [...planImpact.blocked, ...(input.directBlocks ?? [])],
    unblocks: [...planImpact.unblocks, ...(input.directUnblocks ?? [])],
    authorityBoundary: input.authorityBoundary ?? null,
    recoveryBoundary: input.recoveryBoundary ?? null,
    impact,
    evidenceRefs: sortedUniqueEvidence([...planImpact.evidence, ...(input.evidence ?? [])]),
    nextHumanBoundary: input.humanBoundary,
    createdAt: input.createdAt,
  };
}

async function readPlans(tenantId: string, cap: number): Promise<Row[]> {
  return withTenant(tenantId, async (db) => rows(await db.execute(sql`
    SELECT revision.id, revision.work_id, revision.graph_hash, revision.plan_graph
      FROM finnor_os.work_plan_revisions revision
      JOIN finnor_os.works work ON work.tenant_id=revision.tenant_id AND work.id=revision.work_id
     WHERE revision.tenant_id=${tenantId}::uuid
       AND revision.status='active'
       AND work.status IN (${OPEN_WORK_SQL})
     ORDER BY revision.work_id,revision.revision DESC,revision.id
     LIMIT ${Math.max(cap, 500)}
  `)));
}

async function readWorks(tenantId: string, employeeId: string, cap: number): Promise<Row[]> {
  return withTenant(tenantId, async (db) => rows(await db.execute(sql`
    SELECT id,status,current_owner_id,assigned_to,failure,recovery,created_at,updated_at
      FROM finnor_os.works
     WHERE tenant_id=${tenantId}::uuid
       AND status IN (${OPEN_WORK_SQL})
       AND (current_owner_id=${employeeId}::uuid OR assigned_to=${employeeId}::uuid)
     ORDER BY updated_at DESC,id
     LIMIT ${cap}
  `)));
}

async function readApprovalAndHumanRows(tenantId: string, employeeId: string, cap: number): Promise<{ approvals: Row[]; human: Row[] }> {
  return withTenant(tenantId, async (db) => {
    const approvals = rows(await db.execute(sql`
      SELECT request.id request_id,request.domain_action_id action_id,request.created_at,
             step.approver_capability,action.action_type,action.authority_context,
             action.work_id,action.plan_revision_id,action.plan_node_id
        FROM finnor_os.authority_approval_requests request
        JOIN finnor_os.authority_approval_request_steps step
          ON step.tenant_id=request.tenant_id AND step.approval_request_id=request.id AND step.sequence=request.current_step
        JOIN finnor_os.domain_actions action
          ON action.tenant_id=request.tenant_id AND action.id=request.domain_action_id
       WHERE request.tenant_id=${tenantId}::uuid AND request.status='pending' AND step.status='pending'
         AND action.work_id IS NOT NULL AND action.action_type<>'clarification_request'
       ORDER BY request.created_at,request.id
       LIMIT ${cap}
    `));
    const human = rows(await db.execute(sql`
      SELECT action.id action_id,action.action_type,action.payload,action.status,action.created_at,
             action.work_id,action.plan_revision_id,action.plan_node_id,
             work.current_owner_id,work.assigned_to
        FROM finnor_os.domain_actions action
        JOIN finnor_os.works work ON work.tenant_id=action.tenant_id AND work.id=action.work_id
       WHERE action.tenant_id=${tenantId}::uuid
         AND ((action.action_type='clarification_request' AND action.status IN ('draft','pending','needs_human_review'))
           OR (action.status='needs_human_review' AND action.action_type<>'clarification_request'))
         AND (work.current_owner_id=${employeeId}::uuid OR work.assigned_to=${employeeId}::uuid)
       ORDER BY action.created_at,action.id
       LIMIT ${cap}
    `));
    return { approvals, human };
  });
}

async function readObjectives(tenantId: string, employeeId: string, asOf: Date, cap: number): Promise<Row[]> {
  return withTenant(tenantId, async (db) => rows(await db.execute(sql`
    SELECT 'deadline' row_kind,loop.id source_id,loop.work_id,loop.deadline_at deadline,
           loop.created_at,work.current_owner_id,work.assigned_to,
           step.plan_revision_id,step.plan_node_id,NULL::jsonb observation
      FROM finnor_os.work_objective_loops loop
      JOIN finnor_os.works work ON work.tenant_id=loop.tenant_id AND work.id=loop.work_id
      LEFT JOIN LATERAL (
        SELECT item.plan_revision_id,item.plan_node_id FROM finnor_os.work_objective_steps item
         WHERE item.tenant_id=loop.tenant_id AND item.objective_loop_id=loop.id
         ORDER BY item.step_number DESC LIMIT 1
      ) step ON true
     WHERE loop.tenant_id=${tenantId}::uuid
       AND loop.state IN ('continue','awaiting_approval','waiting','blocked')
       AND loop.deadline_at<=${asOf}
       AND (work.current_owner_id=${employeeId}::uuid OR work.assigned_to=${employeeId}::uuid)
    UNION ALL
    SELECT 'blocked' row_kind,step.id source_id,loop.work_id,NULL::timestamptz deadline,
           step.started_at created_at,work.current_owner_id,work.assigned_to,
           step.plan_revision_id,step.plan_node_id,step.observation
      FROM finnor_os.work_objective_steps step
      JOIN finnor_os.work_objective_loops loop ON loop.tenant_id=step.tenant_id AND loop.id=step.objective_loop_id
      JOIN finnor_os.works work ON work.tenant_id=step.tenant_id AND work.id=step.work_id
     WHERE step.tenant_id=${tenantId}::uuid AND step.iteration_outcome='blocked'
       AND loop.state='blocked'
       AND (work.current_owner_id=${employeeId}::uuid OR work.assigned_to=${employeeId}::uuid)
     ORDER BY created_at,source_id
     LIMIT ${cap}
  `)));
}

async function readWaits(tenantId: string, employeeId: string, asOf: Date, cap: number): Promise<Row[]> {
  return withTenant(tenantId, async (db) => rows(await db.execute(sql`
    SELECT wait.id,wait.work_id,wait.deadline_at,wait.status,wait.condition_summary,wait.created_at,
           work.current_owner_id,work.assigned_to,step.plan_revision_id,step.plan_node_id
      FROM finnor_os.work_event_waits wait
      JOIN finnor_os.works work ON work.tenant_id=wait.tenant_id AND work.id=wait.work_id
      JOIN finnor_os.work_objective_steps step ON step.tenant_id=wait.tenant_id AND step.id=wait.objective_step_id
     WHERE wait.tenant_id=${tenantId}::uuid
       AND (wait.status='timed_out' OR (wait.status='waiting' AND wait.deadline_at IS NOT NULL AND wait.deadline_at<=${asOf}))
       AND (work.current_owner_id=${employeeId}::uuid OR work.assigned_to=${employeeId}::uuid)
     ORDER BY wait.deadline_at,wait.id
     LIMIT ${cap}
  `)));
}

async function readBusinessEffects(tenantId: string, employeeId: string, cap: number): Promise<Row[]> {
  return withTenant(tenantId, async (db) => rows(await db.execute(sql`
    SELECT effect.id,effect.status,effect.semantic_hash,effect.created_at,
           action.work_id,action.plan_revision_id,action.plan_node_id,
           work.current_owner_id,work.assigned_to
      FROM finnor_os.business_effects effect
      JOIN finnor_os.domain_actions action ON action.tenant_id=effect.tenant_id AND action.id=effect.domain_action_id
      JOIN finnor_os.works work ON work.tenant_id=action.tenant_id AND work.id=action.work_id
     WHERE effect.tenant_id=${tenantId}::uuid
       AND effect.status IN ('divergent','reconciliation_required')
       AND (work.current_owner_id=${employeeId}::uuid OR work.assigned_to=${employeeId}::uuid)
     ORDER BY effect.created_at,effect.id
     LIMIT ${cap}
  `)));
}

async function readWorkforce(tenantId: string, employeeId: string, cap: number): Promise<{
  assignments: Row[];
  boundaries: Row[];
  proposals: Row[];
}> {
  return withTenant(tenantId, async (db) => {
    const assignments = rows(await db.execute(sql`
      SELECT assignment.id,assignment.work_id,assignment.plan_revision_id,assignment.plan_node_id,
             assignment.state,assignment.failure,assignment.reassignment_reason,assignment.capability,
             assignment.created_at,work.current_owner_id,work.assigned_to
        FROM finnor_os.workforce_assignments assignment
        JOIN finnor_os.works work ON work.tenant_id=assignment.tenant_id AND work.id=assignment.work_id
       WHERE assignment.tenant_id=${tenantId}::uuid
         AND assignment.state IN ('failed','reassigned')
         AND (work.current_owner_id=${employeeId}::uuid OR work.assigned_to=${employeeId}::uuid)
         AND NOT EXISTS (
           SELECT 1 FROM finnor_os.workforce_assignments successor
            WHERE successor.tenant_id=assignment.tenant_id
              AND successor.plan_revision_id=assignment.plan_revision_id
              AND successor.plan_node_id=assignment.plan_node_id
              AND successor.created_at>assignment.created_at
              AND successor.state IN ('queued','claimed','running','waiting','completed')
         )
       ORDER BY assignment.created_at,assignment.id
       LIMIT ${cap}
    `));
    const boundaries = rows(await db.execute(sql`
      SELECT step.id,step.work_id,step.plan_revision_id,step.plan_node_id,step.iteration_outcome,
             step.observation,step.decision_reason,step.started_at created_at,
             work.current_owner_id,work.assigned_to
        FROM finnor_os.work_objective_steps step
        JOIN finnor_os.works work ON work.tenant_id=step.tenant_id AND work.id=step.work_id
       WHERE step.tenant_id=${tenantId}::uuid
         AND step.observation->>'workforceStatus' IN ('human_required','unassigned','blocked')
         AND step.iteration_outcome IN ('waiting','blocked')
         AND (work.current_owner_id=${employeeId}::uuid OR work.assigned_to=${employeeId}::uuid)
       ORDER BY step.started_at,step.id
       LIMIT ${cap}
    `));
    const proposals = rows(await db.execute(sql`
      SELECT proposal.id,proposal.target_id,proposal.target_agent_revision_id,proposal.sample_size,
             proposal.proposed_change,proposal.created_at,
             evidence.observation_id,evidence.work_id,
             work.current_owner_id,work.assigned_to
        FROM finnor_os.learning_proposals proposal
        JOIN LATERAL (
          SELECT observation.id observation_id,observation.work_id
            FROM jsonb_array_elements_text(proposal.observation_refs) reference
            JOIN finnor_os.learning_observations observation
              ON observation.tenant_id=proposal.tenant_id AND observation.id=reference.value::uuid
           ORDER BY reference.value
           LIMIT 1
        ) evidence ON true
        JOIN finnor_os.works work ON work.tenant_id=proposal.tenant_id AND work.id=evidence.work_id
       WHERE proposal.tenant_id=${tenantId}::uuid AND proposal.status='proposed'
       ORDER BY proposal.created_at,proposal.id
       LIMIT ${Math.min(cap, 100)}
    `));
    return { assignments, boundaries, proposals };
  });
}

async function readRoots(tenantId: string, workIds: string[]): Promise<Row[]> {
  if (workIds.length === 0) return [];
  const workIdList = sql.join(workIds.map((workId) => sql`${workId}::uuid`), sql`, `);
  return withTenant(tenantId, async (db) => rows(await db.execute(sql`
    SELECT work_id,entity_type,entity_id,relationship,source
      FROM finnor_os.work_entity_links
     WHERE tenant_id=${tenantId}::uuid AND work_id IN (${workIdList})
     ORDER BY work_id,entity_type,entity_id,relationship
     LIMIT 2000
  `)));
}

async function readPrivateEquity(tenantId: string, employeeId: string, asOf: Date, cap: number): Promise<{
  questions: Row[];
  votes: Row[];
  decisions: Row[];
  conditions: Row[];
}> {
  return withTenant(tenantId, async (db) => {
    const questions = rows(await db.execute(sql`
      SELECT question.id,question.ic_case_id,question.deal_id,question.work_id,
             question.question,question.required_before_vote,question.required_before_decision,
             question.raised_by,question.created_at,
             work.current_owner_id,work.assigned_to,
             EXISTS (
               SELECT 1 FROM finnor_os.pe_ic_committee_membership_versions member
                JOIN finnor_os.pe_ic_cases member_case ON member_case.tenant_id=member.tenant_id
                  AND member_case.committee_config_version_id=member.committee_config_version_id
               WHERE member.tenant_id=question.tenant_id AND member_case.id=question.ic_case_id
                 AND member.employee_id=${employeeId}::uuid
                 AND member.effective_from<=${asOf}
                 AND (member.effective_until IS NULL OR member.effective_until>${asOf})
             ) committee_eligible
        FROM finnor_os.pe_ic_questions question
        LEFT JOIN finnor_os.works work ON work.tenant_id=question.tenant_id AND work.id=question.work_id
       WHERE question.tenant_id=${tenantId}::uuid
         AND question.state IN ('OPEN','ANSWERED')
         AND (question.required_before_vote OR question.required_before_decision)
         AND question.work_id IS NOT NULL
         AND (question.raised_by=${employeeId}::uuid OR work.current_owner_id=${employeeId}::uuid
           OR work.assigned_to=${employeeId}::uuid OR EXISTS (
             SELECT 1 FROM finnor_os.pe_ic_committee_membership_versions member
              JOIN finnor_os.pe_ic_cases member_case ON member_case.tenant_id=member.tenant_id
                AND member_case.committee_config_version_id=member.committee_config_version_id
             WHERE member.tenant_id=question.tenant_id AND member_case.id=question.ic_case_id
               AND member.employee_id=${employeeId}::uuid
               AND member.effective_from<=${asOf}
               AND (member.effective_until IS NULL OR member.effective_until>${asOf})
           ))
       ORDER BY question.created_at,question.id
       LIMIT ${cap}
    `));
    const votes = rows(await db.execute(sql`
      SELECT process.id ic_case_id,process.deal_id,process.current_recommendation_id,
             process.voting_basis_version,process.voting_opened_at created_at,
             linked.work_id,linked.current_owner_id,linked.assigned_to
        FROM finnor_os.pe_ic_cases process
        JOIN finnor_os.pe_ic_committee_membership_versions member
          ON member.tenant_id=process.tenant_id AND member.committee_config_version_id=process.committee_config_version_id
         AND member.employee_id=${employeeId}::uuid AND member.voting_eligible
         AND member.effective_from<=${asOf} AND (member.effective_until IS NULL OR member.effective_until>${asOf})
        LEFT JOIN finnor_os.pe_ic_votes vote
          ON vote.tenant_id=process.tenant_id AND vote.ic_case_id=process.id
         AND vote.recommendation_id=process.current_recommendation_id AND vote.employee_id=${employeeId}::uuid
        JOIN LATERAL (
          SELECT work.id work_id,work.current_owner_id,work.assigned_to
            FROM finnor_os.work_entity_links link
            JOIN finnor_os.works work ON work.tenant_id=link.tenant_id AND work.id=link.work_id
           WHERE link.tenant_id=process.tenant_id
             AND ((link.entity_type='pe_ic_case' AND link.entity_id=process.id)
               OR (link.entity_type='pe_deal' AND link.entity_id=process.deal_id)
               OR (link.entity_type='pe_investment_case' AND link.entity_id=process.investment_case_id))
             AND work.status IN (${OPEN_WORK_SQL})
           ORDER BY CASE link.entity_type WHEN 'pe_ic_case' THEN 0 WHEN 'pe_investment_case' THEN 1 ELSE 2 END,
                    work.updated_at DESC,work.id
           LIMIT 1
        ) linked ON true
       WHERE process.tenant_id=${tenantId}::uuid AND process.state='VOTING'
         AND process.current_recommendation_id IS NOT NULL AND vote.id IS NULL
       ORDER BY process.voting_opened_at,process.id
       LIMIT ${cap}
    `));
    const decisions = rows(await db.execute(sql`
      SELECT process.id ic_case_id,process.deal_id,process.state,process.updated_at created_at,
             linked.work_id,linked.current_owner_id,linked.assigned_to,
             CASE WHEN process.state='READY_FOR_VOTE' THEN 'ic:open_voting' ELSE 'ic:finalize_decision' END capability
        FROM finnor_os.pe_ic_cases process
        JOIN LATERAL (
          SELECT work.id work_id,work.current_owner_id,work.assigned_to
            FROM finnor_os.work_entity_links link
            JOIN finnor_os.works work ON work.tenant_id=link.tenant_id AND work.id=link.work_id
           WHERE link.tenant_id=process.tenant_id
             AND ((link.entity_type='pe_ic_case' AND link.entity_id=process.id)
               OR (link.entity_type='pe_deal' AND link.entity_id=process.deal_id)
               OR (link.entity_type='pe_investment_case' AND link.entity_id=process.investment_case_id))
             AND work.status IN (${OPEN_WORK_SQL})
           ORDER BY CASE link.entity_type WHEN 'pe_ic_case' THEN 0 WHEN 'pe_investment_case' THEN 1 ELSE 2 END,
                    work.updated_at DESC,work.id
           LIMIT 1
        ) linked ON true
       WHERE process.tenant_id=${tenantId}::uuid
         AND (process.state='READY_FOR_VOTE' OR (
           process.state='CONDITIONS_PENDING' AND EXISTS (
             SELECT 1 FROM finnor_os.pe_ic_decision_proposals proposal
              WHERE proposal.tenant_id=process.tenant_id AND proposal.ic_case_id=process.id
                AND proposal.case_version=process.version AND proposal.vote_set_version=process.vote_set_version
                AND proposal.process_status='PROCESS_ELIGIBLE' AND proposal.proposed_outcome IS NOT NULL
           )
         ))
       ORDER BY process.updated_at,process.id
       LIMIT ${Math.min(cap, 40)}
    `));
    const conditions = rows(await db.execute(sql`
      SELECT condition.id,condition.ic_case_id,condition.deal_id,condition.work_id,
             condition.condition_type,condition.title,condition.required,condition.due_at,
             condition.owner_employee_id,condition.created_at,
             work.current_owner_id,work.assigned_to
        FROM finnor_os.pe_ic_conditions condition
        JOIN finnor_os.works work ON work.tenant_id=condition.tenant_id AND work.id=condition.work_id
       WHERE condition.tenant_id=${tenantId}::uuid AND condition.state='ACTIVE'
         AND condition.owner_employee_id=${employeeId}::uuid AND condition.work_id IS NOT NULL
       ORDER BY condition.due_at NULLS LAST,condition.created_at,condition.id
       LIMIT ${cap}
    `));
    return { questions, votes, decisions, conditions };
  });
}

function sourceState<T>(source: SourceRead<T>): SourceState {
  return source.available
    ? { source: source.name, status: "available", tables: source.tables }
    : { source: source.name, status: "unavailable", tables: source.tables, errorCode: source.errorCode ?? "CANONICAL_SOURCE_READ_FAILED" };
}

function unavailableResult(
  asOf: Date,
  limit: number,
  sourceStates: SourceState[],
  employeeId: string | null,
): AttentionQueueResult {
  const source = { kind: "canonical_postgres" as const, tables: [...new Set(sourceStates.flatMap((item) => item.tables))].sort() };
  const sourceStatus: AttentionSourceStatus = {
    status: "unavailable",
    sources: sourceStates,
    unavailableSources: sourceStates.filter((item) => item.status === "unavailable").map((item) => item.source).sort(),
  };
  const page = { limit, returned: 0, totalCount: null, totalCountExact: false, hasMore: false, nextCursor: null, truncated: false };
  return {
    kind: "operational_query_result",
    status: "unavailable",
    data: { items: [], sourceStatus },
    version: OPERATIONAL_QUERY_VERSION,
    intent: "attention_queue",
    source,
    asOf: asOf.toISOString(),
    count: 0,
    truncated: false,
    page,
    meta: { version: OPERATIONAL_QUERY_VERSION, source, asOf: asOf.toISOString() },
    items: [],
    viewer: { employeeId, authorityRevision: null },
    sourceStatus,
  };
}

export async function executeAttentionQueueQuery(
  tenantId: string,
  request: AttentionQueueRequest,
  options: OperationalQueryOptions,
  asOf: Date,
): Promise<AttentionQueueResult> {
  const limit = pageLimit(request, options);
  const employeeId = options.employeeId ?? null;
  const identityTables = ["users", "authority_states", "employee_role_assignments", "role_authority_grants"];
  if (!employeeId) {
    return unavailableResult(asOf, limit, [
      { source: "identity", status: "unavailable", tables: identityTables, errorCode: "AUTHENTICATED_EMPLOYEE_REQUIRED" },
    ], null);
  }
  const ctx: TenantContext = { tenantId, userId: options.userId ?? employeeId, employeeId, role: "owner" };
  let identity: Awaited<ReturnType<typeof employeeAuthoritySnapshot>>;
  try {
    identity = await employeeAuthoritySnapshot(ctx);
  } catch {
    return unavailableResult(asOf, limit, [
      { source: "identity", status: "unavailable", tables: identityTables, errorCode: "EMPLOYEE_AUTHORITY_UNAVAILABLE" },
    ], employeeId);
  }

  const cap = sourceLimit(limit);
  let verticalKey = options.verticalKey;
  try {
    verticalKey ??= (await resolveTenantVertical(tenantId)).verticalKey;
  } catch {
    return unavailableResult(asOf, limit, [
      { source: "identity", status: "available", tables: identityTables },
      { source: "private_equity", status: "unavailable", tables: ["tenant_verticals"], errorCode: "TENANT_VERTICAL_UNAVAILABLE" },
    ], employeeId);
  }
  const includePrivateEquity = verticalKey === PRIVATE_EQUITY_VERTICAL;
  const [planSource, workSource, approvalSource, objectiveSource, waitSource, effectSource, workforceSource, peSource] = await Promise.all([
    readSource("plan", ["work_plan_revisions", "works"], () => readPlans(tenantId, cap), [] as Row[]),
    readSource("work", ["works"], () => readWorks(tenantId, employeeId, cap), [] as Row[]),
    readSource("approval", ["authority_approval_requests", "authority_approval_request_steps", "domain_actions", "works"], () => readApprovalAndHumanRows(tenantId, employeeId, cap), { approvals: [], human: [] } as { approvals: Row[]; human: Row[] }),
    readSource("objective", ["work_objective_loops", "work_objective_steps", "works"], () => readObjectives(tenantId, employeeId, asOf, cap), [] as Row[]),
    readSource("wait", ["work_event_waits", "work_objective_steps", "works"], () => readWaits(tenantId, employeeId, asOf, cap), [] as Row[]),
    readSource("business_effect", ["business_effects", "domain_actions", "works"], () => readBusinessEffects(tenantId, employeeId, cap), [] as Row[]),
    readSource("workforce", ["workforce_assignments", "work_objective_steps", "learning_proposals", "learning_observations", "works"], () => readWorkforce(tenantId, employeeId, cap), { assignments: [], boundaries: [], proposals: [] } as { assignments: Row[]; boundaries: Row[]; proposals: Row[] }),
    includePrivateEquity
      ? readSource("private_equity", [
          "pe_ic_cases", "pe_ic_questions", "pe_ic_votes", "pe_ic_conditions",
          "pe_ic_committee_membership_versions", "pe_ic_decision_proposals", "work_entity_links", "works",
        ], () => readPrivateEquity(tenantId, employeeId, asOf, cap), { questions: [], votes: [], decisions: [], conditions: [] } as { questions: Row[]; votes: Row[]; decisions: Row[]; conditions: Row[] })
      : Promise.resolve({ name: "private_equity" as const, tables: [], available: true, rows: { questions: [], votes: [], decisions: [], conditions: [] } }),
  ]);

  const plans = new Map<string, ActivePlan>();
  const plansByWork = new Map<string, ActivePlan>();
  for (const row of planSource.rows) {
    const plan: ActivePlan = {
      id: text(row.id),
      workId: text(row.work_id),
      graphHash: text(row.graph_hash),
      graph: parseGraph(row.plan_graph),
    };
    plans.set(plan.id, plan);
    if (!plansByWork.has(plan.workId)) plansByWork.set(plan.workId, plan);
  }
  const planFor = (workId: string, planRevisionId?: string | null): ActivePlan | undefined =>
    (planRevisionId ? plans.get(planRevisionId) : undefined) ?? plansByWork.get(workId);

  const drafts: DraftAttentionItem[] = [];
  for (const row of workSource.rows) {
    const workId = text(row.id);
    const actor = workActor(row, employeeId);
    if (!actor) continue;
    const createdAt = iso(row.created_at);
    const plan = planFor(workId);
    if (row.status === "recovery") {
      const recovery = record(row.recovery);
      drafts.push(baseDraft({
        id: `work_recovery:${workId}`,
        workId,
        kind: "work_recovery",
        reason: "Work is in the canonical recovery state and cannot progress until its recovery boundary is resolved.",
        actor,
        createdAt,
        plan,
        evidence: [{ type: "work", id: workId }],
        recoveryBoundary: { source: "work", mode: "recover", reasonCode: nullableText(recovery.code) ?? "WORK_RECOVERY" },
        humanBoundary: { kind: "recover", description: "Inspect current canonical state and choose an allowed recovery or replan control.", capability: null, executable: false },
        directImpact: { blocksWorkCompletion: true },
        directUnblocks: [{ kind: "work_completion", id: workId }],
      }));
    } else if (row.status === "failed") {
      const failure = record(row.failure);
      drafts.push(baseDraft({
        id: `work_failure:${workId}`,
        workId,
        kind: "work_failure",
        reason: "Work is in the canonical failed state and requires an explicit recovery decision.",
        actor,
        createdAt,
        plan,
        evidence: [{ type: "work", id: workId }],
        recoveryBoundary: { source: "work", mode: "recover", reasonCode: nullableText(failure.code) ?? "WORK_FAILED" },
        humanBoundary: { kind: "recover", description: "Inspect the recorded failure and choose an allowed retry, replan, recovery, or terminal disposition.", capability: null, executable: false },
        directImpact: { blocksWorkCompletion: true },
        directUnblocks: [{ kind: "work_completion", id: workId }],
      }));
    }
    drafts.push(baseDraft({
      id: `work_assigned:${workId}`,
      workId,
      kind: "work_assigned",
      reason: actor.basis === "work_assignment" ? "Work is explicitly assigned to this employee." : "This employee is the explicit current Work owner.",
      actor,
      createdAt,
      plan,
      evidence: [{ type: "work", id: workId }],
      humanBoundary: { kind: "accept_assignment", description: "Open the Work and continue only through its currently permitted boundary.", capability: null, executable: false },
    }));
  }

  let approvalEligibility: Record<string, string[]> = {};
  if (approvalSource.available && approvalSource.rows.approvals.length > 0) {
    try {
      approvalEligibility = await eligibleApproversForActions(tenantId, approvalSource.rows.approvals.map((row) => text(row.action_id)));
    } catch {
      approvalSource.available = false;
      approvalSource.errorCode = "APPROVAL_ELIGIBILITY_UNAVAILABLE";
    }
  }
  if (approvalSource.available) {
    for (const row of approvalSource.rows.approvals) {
      const actionId = text(row.action_id);
      if (!(approvalEligibility[actionId] ?? []).includes(employeeId)) continue;
      const workId = text(row.work_id);
      const capability = text(row.approver_capability).replaceAll("$action", text(row.action_type));
      const authorityContext = record(row.authority_context);
      const authorityResources = Array.isArray(authorityContext.resources) ? authorityContext.resources.map(record) : [];
      const first = authorityResources.find((resource) => typeof resource.type === "string" && typeof resource.id === "string");
      const plan = planFor(workId, nullableText(row.plan_revision_id));
      drafts.push(baseDraft({
        id: `approval_required:${text(row.request_id)}`,
        workId,
        kind: "approval_required",
        reason: `A pending approval is the current execution boundary for ${text(row.action_type)}.`,
        actor: { employeeId, basis: "approval_eligibility", capability },
        createdAt: iso(row.created_at),
        plan,
        planNodeId: nullableText(row.plan_node_id),
        evidence: [{ type: "authority_approval_request", id: text(row.request_id) }, { type: "domain_action", id: actionId }],
        authorityBoundary: {
          operation: "approval",
          capability,
          resource: first ? { type: text(first.type), id: text(first.id) } : { type: "domain_action", id: actionId },
          authorityRevision: identity.revision,
          selectionGrantsAuthority: false,
        },
        humanBoundary: { kind: "approve", description: "Review the exact frozen action/effect and approve or reject it through the authority gate.", capability, executable: false },
        directBlocks: [{ kind: "approval", id: text(row.request_id) }],
      }));
    }
    for (const row of approvalSource.rows.human) {
      const workId = text(row.work_id);
      const actor = workActor(row, employeeId);
      if (!actor) continue;
      const actionId = text(row.action_id);
      const plan = planFor(workId, nullableText(row.plan_revision_id));
      const clarification = row.action_type === "clarification_request";
      const payload = record(row.payload);
      drafts.push(baseDraft({
        id: `${clarification ? "clarification_required" : "manual_verification_required"}:${actionId}`,
        workId,
        kind: clarification ? "clarification_required" : "manual_verification_required",
        reason: clarification
          ? `A clarification is required: ${nullableText(payload.question) ?? "the recorded request requires missing information"}`
          : `The ${text(row.action_type)} action is in the canonical needs-human-review state.`,
        actor,
        createdAt: iso(row.created_at),
        plan,
        planNodeId: nullableText(row.plan_node_id),
        evidence: [{ type: "domain_action", id: actionId }],
        recoveryBoundary: clarification ? null : { source: "plan_node", mode: "manual_review", reasonCode: "ACTION_NEEDS_HUMAN_REVIEW" },
        humanBoundary: clarification
          ? { kind: "clarify", description: "Supply the missing fact as a new authenticated Work input; acknowledging this card does not invent the answer.", capability: null, executable: false }
          : { kind: "verify", description: "Inspect the recorded action, evidence, and current state before choosing a permitted recovery path.", capability: null, executable: false },
      }));
    }
  }

  for (const row of objectiveSource.rows) {
    const workId = text(row.work_id);
    const actor = workActor(row, employeeId);
    if (!actor) continue;
    const plan = planFor(workId, nullableText(row.plan_revision_id));
    if (row.row_kind === "deadline") {
      drafts.push(baseDraft({
        id: `deadline_overdue:${text(row.source_id)}`,
        workId,
        kind: "deadline_overdue",
        reason: "The explicit ObjectiveLoop deadline has elapsed while the objective remains non-terminal.",
        actor,
        createdAt: iso(row.created_at),
        deadline: iso(row.deadline),
        plan,
        planNodeId: nullableText(row.plan_node_id),
        evidence: [{ type: "work_objective_loop", id: text(row.source_id) }],
        humanBoundary: { kind: "recover", description: "Inspect current state and choose a deadline-safe recovery, replan, escalation, or stop decision.", capability: null, executable: false },
      }));
    } else if (!nullableText(record(row.observation).workforceStatus)) {
      drafts.push(baseDraft({
        id: `plan_node_blocked:${text(row.source_id)}`,
        workId,
        kind: "plan_node_blocked",
        reason: "The selected Plan node has a recorded blocked iteration outcome.",
        actor,
        createdAt: iso(row.created_at),
        plan,
        planNodeId: nullableText(row.plan_node_id),
        evidence: [{ type: "work_objective_step", id: text(row.source_id) }],
        recoveryBoundary: { source: "plan_node", mode: "replan", reasonCode: "PLAN_NODE_BLOCKED" },
        humanBoundary: { kind: "recover", description: "Inspect the blocker and choose an allowed replan, recovery, escalation, or terminal disposition.", capability: null, executable: false },
        directImpact: { blocksWorkCompletion: true },
        directUnblocks: [{ kind: "work_completion", id: workId }],
      }));
    }
  }

  for (const row of waitSource.rows) {
    const workId = text(row.work_id);
    const actor = workActor(row, employeeId);
    if (!actor) continue;
    const plan = planFor(workId, nullableText(row.plan_revision_id));
    drafts.push(baseDraft({
      id: `wait_timed_out:${text(row.id)}`,
      workId,
      kind: "wait_timed_out",
      reason: row.status === "timed_out"
        ? "The canonical event wait is timed out."
        : "The canonical event-wait deadline has elapsed and the timeout transition is due.",
      actor,
      createdAt: iso(row.created_at),
      deadline: row.deadline_at ? iso(row.deadline_at) : null,
      plan,
      planNodeId: nullableText(row.plan_node_id),
      evidence: [{ type: "work_event_wait", id: text(row.id) }],
      recoveryBoundary: { source: "event_wait", mode: "replan", reasonCode: "EVENT_WAIT_TIMEOUT" },
      humanBoundary: { kind: "recover", description: "Reinspect the expected event and choose a permitted timeout recovery or replan path.", capability: null, executable: false },
      directBlocks: [{ kind: "event_wait", id: text(row.id) }],
      directImpact: { blocksWorkCompletion: true },
      directUnblocks: [{ kind: "work_completion", id: workId }],
    }));
  }

  for (const row of effectSource.rows) {
    const workId = text(row.work_id);
    const actor = workActor(row, employeeId);
    if (!actor) continue;
    const plan = planFor(workId, nullableText(row.plan_revision_id));
    drafts.push(baseDraft({
      id: `manual_verification_required:${text(row.id)}`,
      workId,
      kind: "manual_verification_required",
      reason: `The BusinessEffect is ${text(row.status)} and cannot count as verified completion evidence.`,
      actor,
      createdAt: iso(row.created_at),
      plan,
      planNodeId: nullableText(row.plan_node_id),
      evidence: [{ type: "business_effect", id: text(row.id), hash: text(row.semantic_hash) }],
      recoveryBoundary: { source: "business_effect", mode: row.status === "reconciliation_required" ? "manual_review" : "recover", reasonCode: text(row.status).toUpperCase() },
      humanBoundary: { kind: "verify", description: "Inspect observed versus expected effect truth and resolve through the existing verification/reconciliation controls.", capability: null, executable: false },
      directImpact: { blocksWorkCompletion: true },
      directUnblocks: [{ kind: "work_completion", id: workId }],
    }));
  }

  if (workforceSource.available) {
    for (const row of workforceSource.rows.assignments) {
      const workId = text(row.work_id);
      const actor = workActor(row, employeeId);
      if (!actor) continue;
      const failure = record(row.failure);
      const failureCode = nullableText(failure.code) ?? nullableText(row.reassignment_reason) ?? "AI_ASSIGNMENT_FAILED";
      const budgetExhausted = failureCode === "AUTONOMY_BUDGET_EXHAUSTED";
      const plan = planFor(workId, nullableText(row.plan_revision_id));
      drafts.push(baseDraft({
        id: `${budgetExhausted ? "worker_budget_exhausted" : "ai_assignment_failed"}:${text(row.id)}`,
        workId,
        kind: budgetExhausted ? "worker_budget_exhausted" : "ai_assignment_failed",
        reason: budgetExhausted
          ? `The governed AI assignment stopped at its pinned autonomy budget for ${text(row.capability)}.`
          : `The governed AI assignment for ${text(row.capability)} ended without completing its PlanNode (${failureCode}).`,
        actor,
        createdAt: iso(row.created_at),
        plan,
        planNodeId: nullableText(row.plan_node_id),
        evidence: [{ type: "workforce_assignment", id: text(row.id) }],
        recoveryBoundary: { source: "plan_node", mode: "recover", reasonCode: failureCode },
        humanBoundary: { kind: "recover", description: "Inspect the immutable assignment failure and choose an allowed retry, reassignment, replan, or terminal disposition.", capability: null, executable: false },
        directBlocks: [{ kind: "workforce_assignment", id: text(row.id) }],
        directImpact: { blocksWorkCompletion: true },
        directUnblocks: [{ kind: "work_completion", id: workId }],
      }));
    }

    for (const row of workforceSource.rows.boundaries) {
      const workId = text(row.work_id);
      const actor = workActor(row, employeeId);
      if (!actor) continue;
      const observation = record(row.observation);
      const status = text(observation.workforceStatus);
      const serialized = JSON.stringify(observation);
      const budgetExhausted = serialized.includes('"AUTONOMY_BUDGET_EXHAUSTED"');
      const humanOnly = status === "human_required";
      const kind: AttentionKind = humanOnly ? "human_only_boundary" : budgetExhausted ? "worker_budget_exhausted" : "no_eligible_ai_worker";
      const capability = nullableText(observation.capability);
      const plan = planFor(workId, nullableText(row.plan_revision_id));
      drafts.push(baseDraft({
        id: `${kind}:${text(row.id)}`,
        workId,
        kind,
        reason: humanOnly
          ? `The selected PlanNode is human-only${capability ? ` (${capability})` : ""}; no AI worker may claim it.`
          : budgetExhausted
            ? `Every otherwise relevant worker is outside its governed autonomy budget${capability ? ` for ${capability}` : ""}.`
            : `No configured, enabled AgentProfileRevision is eligible for the selected PlanNode${capability ? ` (${capability})` : ""}.`,
        actor,
        createdAt: iso(row.created_at),
        plan,
        planNodeId: nullableText(row.plan_node_id),
        evidence: [{ type: "work_objective_step", id: text(row.id) }],
        authorityBoundary: humanOnly ? {
          operation: "human_attestation",
          capability: capability ?? "human:execute_plan_boundary",
          resource: { type: "plan_node", id: nullableText(row.plan_node_id) ?? text(row.id) },
          authorityRevision: identity.revision,
          selectionGrantsAuthority: false,
        } : null,
        recoveryBoundary: humanOnly ? null : { source: "plan_node", mode: "escalate", reasonCode: budgetExhausted ? "AUTONOMY_BUDGET_EXHAUSTED" : "NO_ELIGIBLE_AI_WORKER" },
        humanBoundary: humanOnly
          ? { kind: "attest", description: "An authenticated eligible human must act through the existing authority and execution boundary; selecting this item grants nothing.", capability, executable: false }
          : { kind: "recover", description: "Configure or restore an eligible governed worker, or choose an allowed human recovery/replan path.", capability: "workforce:configure_agent", executable: false },
        directImpact: { blocksWorkCompletion: true },
        directUnblocks: [{ kind: "work_completion", id: workId }],
      }));
    }

    const proposalAuthority = await Promise.all(workforceSource.rows.proposals.map(async (row) => ({
      row,
      allowed: await canExerciseAuthority(ctx, {
        operation: "action",
        capability: "workforce:promote_learning",
        resource: { type: "learning_proposal", id: text(row.id) },
        risk: "medium",
      }).catch(() => false),
    })));
    for (const { row, allowed } of proposalAuthority) {
      if (!allowed) continue;
      const workId = text(row.work_id);
      drafts.push(baseDraft({
        id: `learning_proposal_review:${text(row.id)}`,
        workId,
        kind: "learning_proposal_review",
        reason: `A source-pinned workforce learning proposal with ${text(row.sample_size)} verified observations needs explicit human review.`,
        actor: { employeeId, basis: "authority", capability: "workforce:promote_learning" },
        createdAt: iso(row.created_at),
        plan: planFor(workId),
        roots: [rootRef("agent_profile", text(row.target_id), "learning_proposals")],
        evidence: [
          { type: "learning_proposal", id: text(row.id) },
          { type: "learning_observation", id: text(row.observation_id) },
          { type: "agent_profile_revision", id: text(row.target_agent_revision_id) },
        ],
        authorityBoundary: { operation: "governance", capability: "workforce:promote_learning", resource: { type: "learning_proposal", id: text(row.id) }, authorityRevision: identity.revision, selectionGrantsAuthority: false },
        humanBoundary: { kind: "govern", description: "Review the immutable evidence window and explicitly promote or reject this bounded soft change.", capability: "workforce:promote_learning", executable: false },
        directBlocks: [{ kind: "learning_proposal", id: text(row.id) }],
      }));
    }
  }

  if (peSource.available) {
    for (const row of peSource.rows.questions) {
      const workId = text(row.work_id);
      const actor: AttentionActor = row.raised_by === employeeId
        ? { employeeId, basis: "question_owner", capability: null }
        : workActor(row, employeeId) ?? { employeeId, basis: "committee_eligibility", capability: null };
      const boundary = boolean(row.required_before_decision) ? `${text(row.ic_case_id)}:decision` : `${text(row.ic_case_id)}:vote`;
      drafts.push(baseDraft({
        id: `p5_question_blocking:${text(row.id)}`,
        workId,
        kind: "p5_question_blocking",
        reason: `A required Investment Committee Question remains unresolved: ${text(row.question)}`,
        actor,
        createdAt: iso(row.created_at),
        plan: planFor(workId),
        roots: [rootRef("pe_deal", text(row.deal_id), "pe_ic_questions"), rootRef("pe_ic_case", text(row.ic_case_id), "pe_ic_questions")],
        evidence: [{ type: "pe_ic_question", id: text(row.id) }],
        authorityBoundary: { operation: "human_attestation", capability: "ic:answer_question", resource: { type: "pe_ic_question", id: text(row.id) }, authorityRevision: identity.revision, selectionGrantsAuthority: false },
        humanBoundary: { kind: "resolve_question", description: "Answer with exact evidence, then resolve or use the separately governed human-only waiver path.", capability: "ic:answer_question", executable: false },
        directBlocks: [{ kind: "p5_boundary", id: boundary }],
        directUnblocks: [{ kind: "p5_boundary", id: boundary }],
        directImpact: { blocksWorkCompletion: true },
      }));
    }
    for (const row of peSource.rows.votes) {
      const workId = text(row.work_id);
      drafts.push(baseDraft({
        id: `p5_vote_required:${text(row.ic_case_id)}:${employeeId}`,
        workId,
        kind: "p5_vote_required",
        reason: "This employee is an eligible member of the pinned committee configuration and has not voted on the current immutable voting basis.",
        actor: { employeeId, basis: "committee_eligibility", capability: "ic:record_vote" },
        createdAt: iso(row.created_at),
        plan: planFor(workId),
        roots: [rootRef("pe_deal", text(row.deal_id), "pe_ic_cases"), rootRef("pe_ic_case", text(row.ic_case_id), "pe_ic_cases")],
        evidence: [{ type: "pe_ic_case", id: text(row.ic_case_id) }, { type: "pe_ic_recommendation", id: text(row.current_recommendation_id) }],
        authorityBoundary: { operation: "human_attestation", capability: "ic:record_vote", resource: { type: "pe_ic_case", id: text(row.ic_case_id) }, authorityRevision: identity.revision, selectionGrantsAuthority: false },
        humanBoundary: { kind: "vote", description: "Personally record a vote on the exact current recommendation, memo, underwriting run, and voting-basis version.", capability: "ic:record_vote", executable: false },
        directBlocks: [{ kind: "p5_boundary", id: `${text(row.ic_case_id)}:voting` }],
      }));
    }
    const decisionChecks = await Promise.all(peSource.rows.decisions.map(async (row) => ({
      row,
      allowed: await canExerciseAuthority(ctx, {
        operation: "action",
        capability: text(row.capability),
        resource: { type: "pe_ic_case", id: text(row.ic_case_id) },
        risk: "high",
        workId: text(row.work_id),
      }).catch(() => false),
    })));
    for (const { row, allowed } of decisionChecks) {
      if (!allowed) continue;
      const workId = text(row.work_id);
      const capability = text(row.capability);
      const opening = capability === "ic:open_voting";
      drafts.push(baseDraft({
        id: `p5_decision_required:${text(row.ic_case_id)}:${capability}`,
        workId,
        kind: "p5_decision_required",
        reason: opening
          ? "The ICCase is READY_FOR_VOTE and requires an authorized human to open voting on the pinned basis."
          : "The ICCase has a current eligible DecisionProposal and requires authorized human finalization.",
        actor: { employeeId, basis: "authority", capability },
        createdAt: iso(row.created_at),
        plan: planFor(workId),
        roots: [rootRef("pe_deal", text(row.deal_id), "pe_ic_cases"), rootRef("pe_ic_case", text(row.ic_case_id), "pe_ic_cases")],
        evidence: [{ type: "pe_ic_case", id: text(row.ic_case_id) }],
        authorityBoundary: { operation: "governance", capability, resource: { type: "pe_ic_case", id: text(row.ic_case_id) }, authorityRevision: identity.revision, selectionGrantsAuthority: false },
        humanBoundary: { kind: "govern", description: opening ? "Review the exact voting basis and explicitly open voting." : "Review the immutable DecisionProposal proof and explicitly finalize or decline to finalize.", capability, executable: false },
        directBlocks: [{ kind: "p5_boundary", id: `${text(row.ic_case_id)}:${opening ? "open_voting" : "final_decision"}` }],
        directUnblocks: [{ kind: "p5_boundary", id: `${text(row.ic_case_id)}:${opening ? "voting" : "decided"}` }],
        directImpact: { blocksWorkCompletion: true },
      }));
    }
    for (const row of peSource.rows.conditions) {
      const workId = text(row.work_id);
      const due = row.due_at ? iso(row.due_at) : null;
      drafts.push(baseDraft({
        id: `p5_condition_active:${text(row.id)}`,
        workId,
        kind: "p5_condition_active",
        reason: `The assigned Investment Committee Condition is active: ${text(row.title)}`,
        actor: { employeeId, basis: "condition_owner", capability: "action:satisfy_ic_condition" },
        createdAt: iso(row.created_at),
        deadline: due,
        plan: planFor(workId),
        roots: [rootRef("pe_deal", text(row.deal_id), "pe_ic_conditions"), rootRef("pe_ic_case", text(row.ic_case_id), "pe_ic_conditions")],
        evidence: [{ type: "pe_ic_condition", id: text(row.id) }],
        authorityBoundary: { operation: "manual_verification", capability: "action:satisfy_ic_condition", resource: { type: "pe_ic_condition", id: text(row.id) }, authorityRevision: identity.revision, selectionGrantsAuthority: false },
        humanBoundary: { kind: "resolve_condition", description: "Provide exact required evidence and satisfy the condition, or use the separately governed human-only waiver path.", capability: "action:satisfy_ic_condition", executable: false },
        directBlocks: boolean(row.required) ? [{ kind: "p5_boundary", id: `${text(row.ic_case_id)}:${text(row.condition_type).toLowerCase()}` }] : [],
        directUnblocks: boolean(row.required) ? [{ kind: "p5_boundary", id: `${text(row.ic_case_id)}:${text(row.condition_type).toLowerCase()}` }] : [],
        directImpact: { blocksWorkCompletion: boolean(row.required) },
      }));
    }
  }

  // An assignment is a fallback attention source, not a competing priority claim
  // when a concrete blocker/boundary for the same Work already exists.
  const specificWorkIds = new Set(drafts.filter((item) => item.kind !== "work_assigned").map((item) => item.workId));
  let filtered = drafts.filter((item) => item.kind !== "work_assigned" || !specificWorkIds.has(item.workId));
  // Every operational query is itself represented as Work. Never let the query
  // currently computing this projection appear as an employee attention item.
  if (options.workId) filtered = filtered.filter((item) => item.workId !== options.workId);
  const workIds = [...new Set(filtered.map((item) => item.workId))].sort();
  const rootSource = await readSource("root", ["work_entity_links"], () => readRoots(tenantId, workIds), [] as Row[]);
  const rootsByWork = new Map<string, AttentionRootRef[]>();
  for (const row of rootSource.rows) {
    const relationship = row.relationship === "target" || row.relationship === "result" ? row.relationship : "about";
    const root: AttentionRootRef = { entityType: text(row.entity_type), entityId: text(row.entity_id), relationship, source: text(row.source) };
    rootsByWork.set(text(row.work_id), [...(rootsByWork.get(text(row.work_id)) ?? []), root]);
  }
  filtered = filtered.map((item) => ({ ...item, rootRefs: sortedUniqueRoots([...item.rootRefs, ...(rootsByWork.get(item.workId) ?? [])]) }));

  const ranked = filtered.map((item): AttentionItem => {
    const rankVector = buildAttentionRankVector(item, asOf);
    return { ...item, slackMs: rankVector.slackMs, rankVector, rankReason: rankReason(item, rankVector) };
  }).sort(compareAttentionItems);
  const total = ranked.length;
  const items = ranked.slice(0, limit);

  const sourceStates: SourceState[] = [
    { source: "identity", status: "available", tables: identityTables },
    sourceState(workSource),
    sourceState(approvalSource),
    sourceState(objectiveSource),
    sourceState(waitSource),
    sourceState(effectSource),
    sourceState(workforceSource),
    sourceState(planSource),
    sourceState(rootSource),
    includePrivateEquity ? sourceState(peSource) : { source: "private_equity", status: "not_applicable", tables: [] },
  ];
  const required = sourceStates.filter((item) => item.status !== "not_applicable");
  const availableCount = required.filter((item) => item.status === "available").length;
  const unavailableCount = required.length - availableCount;
  const status: AttentionSourceStatus["status"] = unavailableCount === 0 ? "complete" : availableCount === 0 ? "unavailable" : "partial";
  const sourceStatus: AttentionSourceStatus = {
    status,
    sources: sourceStates,
    unavailableSources: sourceStates.filter((item) => item.status === "unavailable").map((item) => item.source).sort(),
  };
  const source = { kind: "canonical_postgres" as const, tables: [...new Set(sourceStates.flatMap((item) => item.tables))].sort() };
  const truncated = total > items.length;
  const page = { limit, returned: items.length, totalCount: total, totalCountExact: true, hasMore: truncated, nextCursor: null, truncated };
  return {
    kind: "operational_query_result",
    status: status === "complete" ? "ok" : status,
    data: { items, viewer: { employeeId, authorityRevision: identity.revision }, sourceStatus },
    version: OPERATIONAL_QUERY_VERSION,
    intent: "attention_queue",
    source,
    asOf: asOf.toISOString(),
    count: items.length,
    truncated,
    page,
    meta: { version: OPERATIONAL_QUERY_VERSION, source, asOf: asOf.toISOString() },
    items,
    viewer: { employeeId, authorityRevision: identity.revision },
    sourceStatus,
  };
}
