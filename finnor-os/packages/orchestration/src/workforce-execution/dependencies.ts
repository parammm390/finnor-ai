import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { PoolClient } from "pg";
import type { TenantContext } from "@finnor/shared-types";
import type { WorkforceCompilerInput, WorkforceExecutionProgram } from "../../../workforce/src/execution-program/schema";
import { workforceProgramGraph } from "../../../workforce/src/execution-program/graph";
import { isLiveWorkforceAssignment } from "../../../workforce/src/execution-program/checker";
import { workforceDigest } from "../../../workforce/src/execution-program/exact";
import { affectedClosure } from "../../../private-equity/src/live-recompilation/contracts";
import { readAllocationSnapshotTx } from "../../../private-equity/src/allocation-store";
import type { WorkforceProgramRow, ResolvedActor } from "./store";
import { resolveWorkforceAuthorityPins, workforceAuthorityPinKey } from "./native-authority";

const { sourceURL } = createRequire(import.meta.url)("@finnor/source-custody") as { sourceURL(path: string): string };
const methods = {
  COMPILER: "packages/workforce/src/execution-program/compiler.ts",
  CHECKER: "packages/workforce/src/execution-program/checker.ts",
  LIFECYCLE: "packages/workforce/src/execution-program/lifecycle.ts",
} as const;
function methodPins() {
  return Object.entries(methods).map(([id, path]) => ({ id,
    digest: createHash("sha256").update(readFileSync(new URL(sourceURL("finnor-os/" + path)))).digest("hex") }));
}

/** P7's unchanged 256-node owner is applied to bounded star partitions until
 * the complete W2 graph reaches a fixed point. No edge or member is omitted;
 * this does not widen P7's existing analytical representation profile. */
export function workforceP7Closure(program: WorkforceExecutionProgram, seeds: string[]) {
  const graph = workforceProgramGraph(program), ids = new Set(program.assignments.map(a => a.id));
  if (program.assignments.length > 8192 || ids.size !== program.assignments.length || seeds.some(id => !ids.has(id)))
    throw Error("WORKFORCE_P7_COMPLETE_GRAPH_REQUIRED");
  const downstream = new Map<string, Set<string>>();
  const edge = (from: string, to: string) => {
    if (!ids.has(from) || !ids.has(to)) throw Error("WORKFORCE_P7_DANGLING_MEMBER");
    if (!downstream.has(from)) downstream.set(from, new Set());
    downstream.get(from)!.add(to);
  };
  for (const assignment of program.assignments) {
    if (assignment.parentAssignmentId) edge(assignment.parentAssignmentId, assignment.id);
    const task = graph.tasks.find(task => task.id === assignment.taskId)!;
    for (const parent of program.assignments) {
      if (task.dependsOn.includes(parent.taskId)) edge(parent.id, assignment.id);
      if (task.returnTo.includes(parent.taskId)) edge(assignment.id, parent.id);
    }
  }
  const affected = new Set<string>(), queue = [...seeds];
  while (queue.length) {
    const seed = queue.pop()!;
    if (affected.has(seed)) continue;
    affected.add(seed);
    const children = [...(downstream.get(seed) ?? [])].filter(id => id !== seed);
    for (let start = 0; start < children.length; start += 255) {
      const star = [{ id: seed, dependsOn: [] as string[] },
        ...children.slice(start, start + 255).map(id => ({ id, dependsOn: [seed] }))];
      queue.push(...affectedClosure(star, [seed]).affectedNodes.map(node => node.id).filter(id => !affected.has(id)));
    }
  }
  return { schema: "finnor.workforce.p7-complete-dependency-closure.v1", seeds: [...new Set(seeds)],
    affectedAssignmentIds: program.assignments.filter(a => affected.has(a.id)).map(a => a.id),
    keptAssignmentIds: program.assignments.filter(a => !affected.has(a.id)).map(a => a.id),
    originalRoot: program.originalOutcome.rootId, originalDeadline: program.originalOutcome.deadline,
    authorityGranted: false, obligationsReleased: false };
}

export async function readWorkforceInvalidations(ctx: TenantContext, q: WorkforceProgramRow,
  actors: ResolvedActor[], c: PoolClient): Promise<NonNullable<WorkforceCompilerInput["dependencyInvalidations"]>> {
  if (!q.program) return [];
  const rows = (await c.query(`SELECT source_kind,source_id,source_digest,assignment_ids FROM finnor_os.w2_dependencies
    WHERE tenant_id=$1 AND program_id=$2 ORDER BY source_kind,source_id LIMIT 8193`, [ctx.tenantId, q.id])).rows;
  if (rows.length > 8192) throw Error("WORKFORCE_DEPENDENCY_PROFILE_INCOMPLETE");
  const snapshot = await readAllocationSnapshotTx({ auth: ctx }, c), currentMethods = new Map(methodPins().map(v => [v.id, v.digest]));
  const live = new Set(q.program.assignments.filter(isLiveWorkforceAssignment).map(a => a.id));
  const authority = new Map((await resolveWorkforceAuthorityPins(ctx, q, q.program, actors, c, live))
    .map(pin => [pin.id, pin]));
  const originals = (await c.query(`SELECT event_id,body FROM finnor_os.w2_events
    WHERE tenant_id=$1 AND program_id=$2 AND kind='CURRENT_AUTHORITY_PIN' LIMIT 8193`,
  [ctx.tenantId, q.id])).rows;
  if (originals.length > 8192) throw Error("WORKFORCE_AUTHORITY_PIN_PROFILE_INCOMPLETE");
  const authorityPreimages = new Map(originals.map(row => [row.event_id, row.body]));
  const result: NonNullable<WorkforceCompilerInput["dependencyInvalidations"]> = [];
  for (const row of rows) {
    let actual: string | null = null;
    if (row.source_kind === "S1_ACTOR_EVIDENCE") actual = actors.find(a => a.sourceId === row.source_id)?.sourceRef.contentDigest ?? null;
    else if (row.source_kind === "METHOD") actual = currentMethods.get(row.source_id) ?? null;
    else if (row.source_kind === "S5_RESOURCE") {
      const resource = snapshot.resources.find(resource => resource.resourceId === row.source_id);
      actual = resource && !resource.revoked && Date.parse(resource.validUntil) > Date.now() ? resource.ref.contentDigest : null;
    } else if (row.source_kind === "CURRENT_AUTHORITY") {
      const original = authorityPreimages.get(workforceAuthorityPinKey(row.source_id));
      if (!original || original.assignmentId !== row.source_id || original.digest !== row.source_digest ||
          workforceDigest(original.proof) !== row.source_digest || original.proof.originalRoot !== q.work_id)
        throw Error("WORKFORCE_ORIGINAL_AUTHORITY_PIN_PREIMAGE_UNAVAILABLE");
      const current = authority.get(row.source_id);
      actual = current?.allowed ? current.digest : null;
    }
    const affected = (row.assignment_ids as string[]).filter(id => live.has(id));
    if (actual !== row.source_digest && affected.length) result.push({ sourceKind: row.source_kind, sourceId: row.source_id,
      expectedDigest: row.source_digest, actualDigest: actual, assignmentIds: affected });
  }
  const pinned = new Set(rows.filter(row => row.source_kind === "CURRENT_AUTHORITY")
    .flatMap(row => row.assignment_ids as string[]));
  for (const id of live) if (!pinned.has(id)) result.push({ sourceKind: "CURRENT_AUTHORITY", sourceId: id,
    expectedDigest: "ORIGINAL_NATIVE_AUTHORITY_PIN_REQUIRED", actualDigest: null, assignmentIds: [id] });
  return result;
}

/** Pins are append-only in meaning. Publishing/re-reading a stale programme
 * cannot adopt the newer source as though its original check had used it. */
export async function pinWorkforceDependencies(ctx: TenantContext, q: WorkforceProgramRow,
  program: WorkforceExecutionProgram, actors: ResolvedActor[], c: PoolClient,
  append: (kind: string, key: string, body: Record<string, unknown>) => Promise<unknown>) {
  const graph = workforceProgramGraph(program);
  const existing = (await c.query(`SELECT source_kind,source_id,source_digest,assignment_ids FROM finnor_os.w2_dependencies
    WHERE tenant_id=$1 AND program_id=$2 LIMIT 8193`, [ctx.tenantId, q.id])).rows;
  if (existing.length > 8192) throw Error("WORKFORCE_DEPENDENCY_PROFILE_INCOMPLETE");
  const pins: Array<{ kind: string; id: string; digest: string; ids: string[] }> = [];
  const oldAuthorityIds = new Set(existing.filter(row => row.source_kind === "CURRENT_AUTHORITY")
    .flatMap(row => row.assignment_ids as string[]));
  const freshAuthorityIds = new Set(program.assignments.filter(assignment =>
    !oldAuthorityIds.has(assignment.id)).map(assignment => assignment.id));
  const authority = await resolveWorkforceAuthorityPins(ctx, q, program, actors, c, freshAuthorityIds);
  for (const pin of authority) {
    await append("CURRENT_AUTHORITY_PIN", workforceAuthorityPinKey(pin.id), {
      schema: "finnor.workforce-native-authority-pin.v1", assignmentId: pin.id,
      digest: pin.digest, proof: pin.proof, allowedAtPin: pin.allowed, executionAuthorityGranted: false });
    pins.push({ kind: "CURRENT_AUTHORITY", id: pin.id, digest: pin.digest, ids: [pin.id] });
  }
  const tasks = new Map(graph.tasks.map(task => [task.id, task]));
  const criteria = new Map(graph.criteria.map(criterion => [criterion.id, criterion]));
  const assignmentIdsByActor = new Map<string, string[]>();
  for (const assignment of program.assignments) {
    const task = tasks.get(assignment.taskId), criterion = task && criteria.get(task.criterionId);
    if (!task || !criterion) throw Error("WORKFORCE_COMPLETE_DEPENDENCY_GRAPH_REQUIRED");
    for (const id of new Set([assignment.actorId, assignment.delegatorActorId,
      criterion.checkerActorId, criterion.evidenceCustodianActorId])) {
      const ids = assignmentIdsByActor.get(id) ?? [];
      ids.push(assignment.id); assignmentIdsByActor.set(id, ids);
    }
  }
  for (const actor of actors) {
    const ids = assignmentIdsByActor.get(actor.actor.id) ?? [];
    if (ids.length) pins.push({ kind: "S1_ACTOR_EVIDENCE", id: actor.sourceId, digest: actor.sourceRef.contentDigest, ids });
  }
  for (const resource of q.budget.resources) pins.push({ kind: "S5_RESOURCE", id: resource.resourceId,
    digest: resource.ref.contentDigest, ids: program.assignments.filter(a =>
      tasks.get(a.taskId)!.demand.some(e => e.resourceId === resource.resourceId)).map(a => a.id) });
  for (const method of methodPins()) pins.push({ kind: "METHOD", id: method.id, digest: method.digest,
    ids: program.assignments.map(a => a.id) });
  for (const pin of pins) {
    const alreadyChecked = new Set(existing.filter(row => row.source_kind === pin.kind && row.source_id === pin.id)
      .flatMap(row => row.assignment_ids as string[]));
    const freshlyChecked = pin.ids.filter(id => !alreadyChecked.has(id));
    if (!freshlyChecked.length) continue;
    await c.query(`INSERT INTO finnor_os.w2_dependencies
    (tenant_id,program_id,principal_id,source_kind,source_id,source_digest,assignment_ids)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(tenant_id,program_id,source_kind,source_id,source_digest)
    DO UPDATE SET assignment_ids=(SELECT jsonb_agg(DISTINCT value) FROM
      jsonb_array_elements(w2_dependencies.assignment_ids||excluded.assignment_ids))`,
    [ctx.tenantId, q.id, q.principal_id, pin.kind, pin.id, pin.digest, JSON.stringify(freshlyChecked)]);
  }
}
