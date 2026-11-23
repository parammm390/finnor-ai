import type { PoolClient, QueryResultRow } from "pg";
import type { TenantContext } from "@finnor/shared-types";
import { epistemicHash } from "../../../epistemic-runtime/src/source-precedence";
import { workforceDigest } from "../../../workforce/src/execution-program/exact";
import { nativeWorkforceOriginalSchema } from "../../../orchestration/src/workforce-execution/contracts";
import { HarnessRequestSchema, type AnalyticalHarnessRequest } from "../program-synthesis/contracts";
import { ComputeSearchRequestSchema } from "../compute-search/contracts";
import { organizationResourceOwner, OrganizationTransformationError, type OrganizationResourceOwner } from "./contracts";
import { orgFail, principal, rawDigest } from "./store";

interface WorkSource { id: string; initial_instruction: string; created_by: string }
interface ReservationSource { reservation_id: string; allocation_digest: string; body: Record<string, unknown> | null;
  problem: Record<string, unknown> | null; certificate: Record<string, unknown> | null }
interface P1Row { id: string; work_id: string; work_input_id: string; work_input_digest: string; episode_id: string;
  plan_revision_id: string; request_digest: string; request: unknown; proposed: unknown; generation: number;
  status: string; head_id: string | null; claim_fence: string | null }
interface P1Episode { id: string; work_id: string; deadline_at: Date; max_steps: number; max_attempts: number;
  max_candidates: number; max_depth: number; attempts_used: number; steps_used: number; candidates_used: number }
interface P2Row { id: string; program_id: string; request: unknown; request_digest: string; binding: unknown;
  generation: number; status: string; revision: number; head_id: string | null }
interface W2Row { id: string; work_id: string; work_input_id: string; idempotency_key: string; request_digest: string;
  original_digest: string; original: unknown; budget: unknown; status: string; revision: number; program: unknown }
interface Head { id: string; request_id?: string; body: unknown; digest: string }
interface CoreInput { id: string; work_id: string; instruction_text: string; created_by: string; body: Record<string, unknown> }
interface OwnerBinding { certificateId: string; reservationId: string | null; owner: OrganizationResourceOwner }
interface OwnerFailure { certificateId: string; reservationId: string | null; ownerId: string; code: string }
type Table = "p1_requests" | "p1_episodes" | "p1_programs" | "p2_requests" | "p2_plans" | "p2_attempts" | "w2_programs";
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const same = (a: unknown, b: unknown) => epistemicHash(a) === epistemicHash(b);
const integer = (value: unknown) => {
  if (!(typeof value === "number" || typeof value === "string" && /^\d+$/.test(value)) ||
      !Number.isSafeInteger(Number(value)) || Number(value) < 0) orgFail("W5_NATIVE_OWNER_COUNTER_PREIMAGE_REQUIRED");
  return Number(value);
};

/** Actual native P1/P2/W2 lineage. The caller already holds the S5 mutex and
 * writer fences. No owner row, grant, program, Work or attempt is created. */
export async function readOrganizationResourceOwnersTx(ctx: TenantContext, works: WorkSource[],
  reservations: ReservationSource[], c: PoolClient): Promise<{ bindings: OwnerBinding[]; failures: OwnerFailure[] }> {
  let bytesRemaining = 32 * 1024 * 1024;
  const base = [ctx.tenantId, principal(ctx)], bindings: OwnerBinding[] = [], failures: OwnerFailure[] = [];
  // Preflight full owner bytes before PostgreSQL/Node expand large JSON rows.
  const load = async <T extends QueryResultRow>(table: Table, filter: string, values: unknown[], jsonColumns: string[],
    maximum = 128, lock = "FOR SHARE"): Promise<T[]> => {
    const bytes = jsonColumns.map(name => `COALESCE(octet_length(${name}::text),0)`).join("+") || "0";
    const selected = (await c.query<{ id: string; bytes: string }>(`SELECT id,(${bytes})::bigint::text bytes
      FROM finnor_os.${table} WHERE tenant_id=$1 AND principal_id=$2 AND (${filter})
      ORDER BY id LIMIT ${maximum + 1} ${lock}`, [...base, ...values])).rows;
    const total = selected.reduce((sum, row) => sum + integer(row.bytes), 0);
    if (selected.length > maximum || total > bytesRemaining) orgFail("W5_COMPLETE_NATIVE_OWNER_READ_PROFILE_BOUND");
    bytesRemaining -= total;
    if (!selected.length) return [];
    const rows = (await c.query<T>(`SELECT * FROM finnor_os.${table} WHERE tenant_id=$1 AND principal_id=$2
      AND id=ANY($3::uuid[]) ORDER BY id ${lock}`, [...base, selected.map(row => row.id)])).rows;
    if (rows.length !== selected.length) orgFail("W5_COMPLETE_NATIVE_OWNER_PREIMAGE_REQUIRED");
    return rows;
  };
  const certificates = [...new Set(reservations.flatMap(r => {
    const ref = record(r.certificate?.ref);
    return typeof ref?.id === "string" ? [ref.id] : [];
  }))];
  const p1 = await load<P1Row>("p1_requests",
    "request#>>'{ownerBindings,allocationRef,id}'=ANY($3::text[]) OR work_id=ANY($4::uuid[])",
    [certificates, works.map(work => work.id)], ["request", "proposed"], 128, "FOR UPDATE");
  const episodes = await load<P1Episode>("p1_episodes", "id=ANY($3::uuid[])",
    [p1.map(row => row.episode_id)], [], 128);
  const p2 = await load<P2Row>("p2_requests",
    "program_id=ANY($3::uuid[]) OR request#>>'{computeGrant,id}'=ANY($4::text[])",
    [p1.map(row => row.id), certificates], ["request", "binding", "context"], 128, "FOR UPDATE");
  const w2 = await load<W2Row>("w2_programs", "budget#>>'{reservationRef,id}'=ANY($3::text[])",
    [reservations.map(row => row.reservation_id)], ["original", "budget", "program", "compile_result"], 128, "FOR UPDATE");
  // Each owner pins its accepted input. A follow-up can leave earlier resource use outstanding.
  const inputIds = [...new Set([...p1.map(row => row.work_input_id), ...w2.map(row => row.work_input_id)])];
  const inputBounds = (await c.query<{ id: string; bytes: string }>(`SELECT i.id,
    (octet_length(i.instruction_text)+octet_length(to_jsonb(i)::text))::bigint::text bytes
    FROM finnor_os.work_inputs i WHERE i.tenant_id=$1 AND i.id=ANY($2::uuid[])
    ORDER BY i.id FOR SHARE OF i`, [ctx.tenantId, inputIds])).rows;
  const inputBytes = inputBounds.reduce((sum, row) => sum + integer(row.bytes), 0);
  if (inputBytes > bytesRemaining) orgFail("W5_COMPLETE_NATIVE_OWNER_READ_PROFILE_BOUND");
  bytesRemaining -= inputBytes;
  const inputs = (await c.query<CoreInput>(`SELECT i.id,i.work_id,i.instruction_text,i.created_by,to_jsonb(i) body
    FROM finnor_os.work_inputs i WHERE i.tenant_id=$1 AND i.id=ANY($2::uuid[]) ORDER BY i.id FOR SHARE OF i`,
    [ctx.tenantId, inputBounds.map(row => row.id)])).rows;
  const p1Heads = await load<Head>("p1_programs", "id=ANY($3::uuid[])",
    [p1.flatMap(row => row.head_id ? [row.head_id] : [])], ["body"], 128, "");
  const p2Heads = await load<Head>("p2_plans", "id=ANY($3::uuid[])",
    [p2.flatMap(row => row.head_id ? [row.head_id] : [])], ["body"], 128, "");
  const attempts = await load<{ id: string; search_id: string; unit_id: string; delivery_id: string;
    claim_fence: string; status: string; body: unknown; digest: string }>("p2_attempts", "search_id=ANY($3::uuid[])",
    [p2.map(row => row.id)], ["body"], 4096, "FOR UPDATE");
  const usage = (await c.query<{ grant_digest: string; resource_id: string; spent: number }>(`SELECT grant_digest,resource_id,spent
    FROM finnor_os.p2_grant_usage WHERE tenant_id=$1 AND principal_id=$2 AND grant_digest=ANY($3::text[])
    ORDER BY grant_digest,resource_id LIMIT 4097 FOR SHARE`, [...base, reservations.flatMap(row => {
      const ref = record(row.certificate?.ref); return typeof ref?.contentDigest === "string" ? [ref.contentDigest] : [];
    })])).rows;
  if (usage.length > 4096) orgFail("W5_COMPLETE_ORIGINAL_NATIVE_GRANT_USAGE_REQUIRED");
  const w2HeadBytes = integer((await c.query<{ bytes: string }>(`SELECT COALESCE(sum(
    octet_length(h.program::text)+octet_length(h.check_result::text)),0)::bigint::text bytes
    FROM finnor_os.w2_program_revisions h JOIN finnor_os.w2_programs p
      ON p.tenant_id=h.tenant_id AND p.id=h.program_id AND p.revision=h.revision
    WHERE p.tenant_id=$1 AND p.principal_id=$2 AND p.id=ANY($3::uuid[])`, [...base, w2.map(row => row.id)])).rows[0]?.bytes);
  if (w2HeadBytes > bytesRemaining) orgFail("W5_COMPLETE_NATIVE_OWNER_READ_PROFILE_BOUND");
  bytesRemaining -= w2HeadBytes;
  const w2Heads = (await c.query<{ program_id: string; revision: number; program: unknown; check_result: unknown }>(
    `SELECT h.program_id,h.revision,h.program,h.check_result FROM finnor_os.w2_program_revisions h
      JOIN finnor_os.w2_programs p ON p.tenant_id=h.tenant_id AND p.id=h.program_id AND p.revision=h.revision
      WHERE p.tenant_id=$1 AND p.principal_id=$2 AND p.id=ANY($3::uuid[]) ORDER BY h.program_id`,
    [...base, w2.map(row => row.id)])).rows;
  const originalWork = (workId: string, inputId: string) => {
    const work = works.find(row => row.id === workId), input = inputs.find(row => row.work_id === workId && row.id === inputId);
    if (!work || !input) orgFail("W5_ORIGINAL_COMPANY_LINKED_NATIVE_OWNER_WORK_INPUT_REQUIRED");
    return { work, input };
  };
  const accept = (certificateId: string, reservationId: string | null, value: unknown) => {
    const parsed = organizationResourceOwner.safeParse(value);
    if (!parsed.success) orgFail("W5_SUPPORTED_ORIGINAL_NATIVE_OWNER_SHAPE_REQUIRED");
    bindings.push({ certificateId, reservationId, owner: parsed.data });
    return parsed.data;
  };
  const failure = (certificateId: string, reservationId: string | null, ownerId: string, error: unknown) => {
    if (!(error instanceof OrganizationTransformationError)) throw error;
    failures.push({ certificateId, reservationId, ownerId, code: error.code });
  };
  const verifiedP1 = new Map<string, { row: P1Row; request: AnalyticalHarnessRequest;
    owner: OrganizationResourceOwner; certificateId: string }>();
  for (const row of p1) {
    const reference = record(record(record(row.request)?.ownerBindings)?.allocationRef), certificateId = String(reference?.id ?? "");
    try {
      const parsed = HarnessRequestSchema.safeParse(row.request);
      if (!parsed.success || epistemicHash(row.request) !== row.request_digest || !same(parsed.data, row.request))
        orgFail("W5_P1_ORIGINAL_REQUEST_DIGEST_REQUIRED");
      const request = parsed.data, allocationRef = request.ownerBindings?.allocationRef;
      const matched = reservations.filter(r => same(r.certificate?.ref, allocationRef) &&
        same(r.body?.certificateRef, allocationRef) && r.allocation_digest === allocationRef?.contentDigest);
      if (allocationRef && !matched.length) orgFail("W5_P1_EXACT_ORIGINAL_S5_CERTIFICATE_BINDING_REQUIRED");
      const { input } = originalWork(row.work_id, row.work_input_id), proposed = record(row.proposed);
      const work = record(proposed?.work), bounds = record(proposed?.bounds);
      const episode = episodes.find(e => e.id === row.episode_id);
      if (!proposed || proposed.schema !== "finnor.harness-program.v1" || !episode || proposed.id !== row.id ||
          proposed.tenantId !== ctx.tenantId || proposed.principalId !== principal(ctx) ||
          episode.work_id !== row.work_id || epistemicHash(input.body) !== row.work_input_digest ||
          request.workId && request.workId !== row.work_id || request.workInputId && request.workInputId !== row.work_input_id ||
          work?.id !== row.work_id || work.revision !== row.work_input_id || work.inputDigest !== row.work_input_digest ||
          work.planRevisionId !== row.plan_revision_id ||
          bounds?.episodeId !== row.episode_id || typeof bounds.deadlineAt !== "string" ||
          Date.parse(bounds.deadlineAt) !== episode.deadline_at.getTime())
        orgFail("W5_P1_EXACT_CANONICAL_WORK_INPUT_AND_ORIGINAL_EPISODE_REQUIRED");
      const originalLimits = { maxSteps: integer(episode.max_steps), maxAttempts: integer(episode.max_attempts),
        maxCandidates: integer(episode.max_candidates), maxDepth: integer(episode.max_depth) };
      if (Object.entries(originalLimits).some(([key, value]) => bounds[key] !== value))
        orgFail("W5_P1_ORIGINAL_EPISODE_LIMITS_REQUIRED");
      const head = row.head_id ? p1Heads.find(h => h.id === row.head_id && h.request_id === row.id) : null;
      if (row.head_id && (!head || epistemicHash(head.body) !== head.digest ||
          !same(record(head.body)?.work, proposed.work) || !same(record(head.body)?.bounds, bounds)))
        orgFail("W5_P1_ORIGINAL_IMMUTABLE_HEAD_REQUIRED");
      const owner = accept(certificateId, null, { owner: "P1", id: row.id, parentId: null,
        workId: row.work_id, workInputId: row.work_input_id, workInputDigest: row.work_input_digest, requestDigest: row.request_digest,
        originalTermsDigest: epistemicHash({ request: row.request, proposed: row.proposed, episodeId: row.episode_id, originalLimits }),
        originalDeadline: bounds.deadlineAt, originalLimits, observedCounters: { attemptsUsed: integer(episode.attempts_used),
          stepsUsed: integer(episode.steps_used), candidatesUsed: integer(episode.candidates_used) },
        generation: row.generation, status: row.status, currentNativeStateDigest: epistemicHash({
          status: row.status, generation: row.generation, head: head?.digest ?? null, claimFence: row.claim_fence ?? null }),
        physicalAttempts: [], physicalAttemptCoverage: "NOT_A_P2_PHYSICAL_ATTEMPT_METER",
        counterAccounting: "ORIGINAL_NATIVE_COUNTERS_NOT_ADDITIVE_MONEY" });
      verifiedP1.set(row.id, { row, request, owner, certificateId });
    } catch (error) { failure(certificateId, null, row.id, error); }
  }
  for (const row of p2) {
    const certificateId = String(record(record(row.request)?.computeGrant)?.id ?? "");
    try {
      const parsed = ComputeSearchRequestSchema.safeParse(row.request), parent = verifiedP1.get(row.program_id);
      if (!parsed.success || epistemicHash(row.request) !== row.request_digest || !same(parsed.data, row.request) ||
          !parent || parsed.data.programId !== row.program_id ||
          !same(parsed.data.computeGrant, parent.request.ownerBindings?.allocationRef) ||
          !same(parsed.data.policyRequest, parent.request.ownerBindings?.policyRef))
        orgFail("W5_P2_EXACT_PARENT_FK_REQUEST_AND_ORIGINAL_OWNER_BINDINGS_REQUIRED");
      const native = record(row.binding), ref = parent.request.ownerBindings?.allocationRef;
      if (!ref) orgFail("W5_P2_EXACT_ORIGINAL_S5_CERTIFICATE_BINDING_REQUIRED");
      const reservation = reservations.find(r => same(r.body?.ref, native?.reservationRef) && same(r.certificate?.ref, ref));
      if (!reservation || !same(native?.computeGrant, ref) || !same(native?.policyRequest, parsed.data.policyRequest))
        orgFail("W5_P2_ORIGINAL_S5_RESERVATION_AND_POLICY_REQUIRED");
      const physicalAttempts = attempts.filter(a => a.search_id === row.id).map(a => {
        if (epistemicHash(a.body) !== a.digest) orgFail("W5_P2_NATIVE_PHYSICAL_ATTEMPT_PREIMAGE_REQUIRED");
        return { id: a.id, unitId: a.unit_id, deliveryId: a.delivery_id, claimFence: integer(a.claim_fence),
          status: a.status, preimageDigest: a.digest };
      });
      const head = row.head_id ? p2Heads.find(h => h.id === row.head_id) : null, body = record(head?.body);
      if (row.head_id && (!head || epistemicHash(head.body) !== head.digest || body?.id !== row.id ||
          body.programId !== row.program_id || !same(body.computeGrant, ref) ||
          record(body.work)?.revision !== parent.row.work_input_id || record(body.work)?.inputDigest !== parent.row.work_input_digest))
        orgFail("W5_P2_ORIGINAL_IMMUTABLE_PLAN_HEAD_REQUIRED");
      accept(certificateId, reservation.reservation_id, { owner: "P2", id: row.id, parentId: row.program_id,
        workId: parent.row.work_id, workInputId: parent.row.work_input_id, workInputDigest: parent.row.work_input_digest,
        requestDigest: row.request_digest, originalTermsDigest: epistemicHash({ request: row.request, binding: row.binding }),
        originalDeadline: parent.owner.originalDeadline, originalLimits: parsed.data.limits,
        observedCounters: { physicalAttempts: physicalAttempts.length, ...Object.fromEntries(usage
          .filter(u => u.grant_digest === ref.contentDigest).map(u => ["nativeGrantSpent:" + u.resource_id, integer(u.spent)])) },
        generation: row.generation, status: row.status, currentNativeStateDigest: epistemicHash({
          status: row.status, revision: row.revision, head: head?.digest ?? null, physicalAttempts }),
        physicalAttempts, physicalAttemptCoverage: "P2_NATIVE_ATTEMPT_ROWS_NOT_PROVIDER_BILLING",
        counterAccounting: "ORIGINAL_NATIVE_COUNTERS_NOT_ADDITIVE_MONEY" });
    } catch (error) { failure(certificateId, null, row.id, error); }
  }
  for (const row of w2) {
    const budget = record(row.budget), reservationId = String(record(budget?.reservationRef)?.id ?? "");
    const certificateId = String(record(budget?.certificateRef)?.id ?? "");
    try {
      const { work, input } = originalWork(row.work_id, row.work_input_id), original = nativeWorkforceOriginalSchema.safeParse(row.original);
      let rawOriginal: unknown;
      try { rawOriginal = JSON.parse(input.instruction_text); }
      catch { orgFail("W5_W2_EXACT_NATIVE_ORIGINAL_WORK_INPUT_REQUIRED"); }
      const originalInput = nativeWorkforceOriginalSchema.safeParse(rawOriginal);
      const reservation = reservations.find(r => r.reservation_id === reservationId);
      if (!original.success || !budget || !reservation || work.created_by !== principal(ctx) || input.created_by !== principal(ctx) ||
          input.instruction_text !== work.initial_instruction || rawDigest(input.instruction_text) !== row.original_digest ||
          !originalInput.success || workforceDigest(originalInput.data) !== workforceDigest(row.original) ||
          workforceDigest({ workId: row.work_id, workInputId: row.work_input_id, idempotencyKey: row.idempotency_key }) !== row.request_digest ||
          budget.programmeId !== row.id || budget.workId !== row.work_id || reservation.problem?.programmeId !== row.id ||
          !same(budget.reservationRef, reservation.body?.ref) || !same(budget.certificateRef, reservation.certificate?.ref) ||
          !same(budget.envelopes, reservation.body?.envelopes) || budget.validUntil !== reservation.certificate?.validUntil ||
          budget.schema !== "finnor.s5.workforce-budget.v1" || budget.tenantId !== ctx.tenantId || budget.principalId !== principal(ctx) ||
          budget.executionAuthorityGranted !== false || budget.protectedReceipt !== null)
        orgFail("W5_W2_EXACT_NATIVE_ORIGINAL_WORK_TERMS_AND_S5_BUDGET_REQUIRED");
      const { ref: budgetRef, ...budgetBody } = budget;
      const nativeBudgetRef = record(budgetRef);
      if (!nativeBudgetRef || epistemicHash(budgetBody) !== nativeBudgetRef.contentDigest || nativeBudgetRef.owner !== "S5" ||
          nativeBudgetRef.version !== "s5-workforce-v1" || nativeBudgetRef.id !== "workforce-budget:" + nativeBudgetRef.contentDigest)
        orgFail("W5_W2_ORIGINAL_NATIVE_BUDGET_PREIMAGE_REQUIRED");
      const head = w2Heads.find(h => h.program_id === row.id && h.revision === row.revision);
      if (row.program && (!head || workforceDigest(head.program) !== workforceDigest(row.program)))
        orgFail("W5_W2_ORIGINAL_IMMUTABLE_PROGRAMME_HEAD_REQUIRED");
      accept(certificateId, reservationId, { owner: "W2", id: row.id, parentId: null,
        workId: row.work_id, workInputId: row.work_input_id, workInputDigest: row.original_digest, requestDigest: row.request_digest,
        originalTermsDigest: workforceDigest({ original: row.original, budget: row.budget }),
        originalDeadline: original.data.outcome.deadline, originalLimits: {}, observedCounters: { revision: integer(row.revision) },
        generation: null, status: row.status, currentNativeStateDigest: workforceDigest({
          status: row.status, revision: row.revision, head: head?.program ?? null, check: head?.check_result ?? null }),
        physicalAttempts: [], physicalAttemptCoverage: "NOT_A_P2_PHYSICAL_ATTEMPT_METER",
        counterAccounting: "ORIGINAL_NATIVE_COUNTERS_NOT_ADDITIVE_MONEY" });
    } catch (error) { failure(certificateId, reservationId, row.id, error); }
  }
  return { bindings, failures };
}
