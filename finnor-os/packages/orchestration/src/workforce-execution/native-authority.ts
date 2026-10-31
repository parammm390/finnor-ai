import type { PoolClient } from "pg";
import type { AuthorityRequest, TenantContext } from "@finnor/shared-types";
import { readWorkforceAuthoritySourcesTx, type CanonicalAuthoritySourceProof } from "@finnor/authority";
import { workforceDigest, workforceProgramGraph,
  type WorkforceExecutionProgram } from "../../../workforce/src/execution-program/index";
import type { ResolvedActor, WorkforceProgramRow } from "./store";

export const workforceAuthorityPinKey = (assignmentId: string) => "current-authority-pin:" + assignmentId;
export interface WorkforceAuthorityPin {
  id: string;
  digest: string;
  allowed: boolean;
  proof: {
    schema: "finnor.workforce-native-authority-source.v1";
    assignmentId: string;
    originalRoot: string;
    roles: Array<{ role: string; actorId: string; principalId: string | null;
      actorStatus: string; source: CanonicalAuthoritySourceProof | null }>;
    executionAuthorityGranted: false;
  };
}

/** Every live leaf is checked. Only fresh, transaction-local current-source
 * reads are shared; persisted pins are evidence of the old check, not permits. */
export async function resolveWorkforceAuthorityPins(ctx: TenantContext, q: WorkforceProgramRow,
  program: WorkforceExecutionProgram, actors: ResolvedActor[], c: PoolClient,
  onlyAssignmentIds?: ReadonlySet<string>): Promise<WorkforceAuthorityPin[]> {
  const graph = workforceProgramGraph(program), tasks = new Map(graph.tasks.map(task => [task.id, task]));
  const criteria = new Map(graph.criteria.map(value => [value.id, value]));
  const bindings = new Map(actors.map(actor => [actor.actor.id, actor]));
  const byPrincipal = new Map<string, Map<string, AuthorityRequest>>();
  const specifications = program.assignments.filter(assignment =>
    !onlyAssignmentIds || onlyAssignmentIds.has(assignment.id)).map(assignment => {
    const task = tasks.get(assignment.taskId), criterion = task && criteria.get(task.criterionId);
    if (!task || !criterion) throw new Error("WORKFORCE_COMPLETE_AUTHORITY_GRAPH_REQUIRED");
    const request = (role: string, actorId: string, capability: string, resourceType: string, resourceId: string) => {
      const binding = bindings.get(actorId);
      const value: AuthorityRequest = { operation: capability.startsWith("query:") ? "query" : "action",
        capability, workId: q.work_id, resource: { type: resourceType, id: resourceId }, risk: "low" };
      const key = workforceDigest(value);
      if (binding) {
        const group = byPrincipal.get(binding.principalId) ?? new Map<string, AuthorityRequest>();
        group.set(key, value); byPrincipal.set(binding.principalId, group);
      }
      return { role, actorId, binding, key };
    };
    return { assignment, requests: [
      request("PRODUCER_RESPOND", assignment.actorId, "action:workforce_respond_contract", "workforce_assignment", assignment.id),
      request("DELEGATOR_ASSIGN", assignment.delegatorActorId, "action:workforce_assign_contract", "workforce_assignment",
        assignment.parentAssignmentId ?? assignment.id),
      request("CHECKER_RESPOND", criterion.checkerActorId, "action:workforce_respond_contract", "workforce_assignment", assignment.id),
      request("CUSTODIAN_READ", criterion.evidenceCustodianActorId, "query:work", "work", q.work_id),
    ] };
  });
  const resolved = new Map<string, Map<string, CanonicalAuthoritySourceProof>>();
  const population = await readWorkforceAuthoritySourcesTx(ctx,
    new Map([...byPrincipal].map(([principalId, requests]) => [principalId, [...requests.values()]])), c);
  for (const [principalId, requests] of byPrincipal) {
    const proof = population.get(principalId)?.proofs;
    if (proof) {
      const keys = [...requests.keys()];
      resolved.set(principalId, new Map(keys.map((key, index) => [key, proof[index]!])));
    }
  }
  return specifications.map(({ assignment, requests }) => {
    const proof: WorkforceAuthorityPin["proof"] = { schema: "finnor.workforce-native-authority-source.v1",
      assignmentId: assignment.id, originalRoot: q.work_id, roles: requests.map(value => ({
        role: value.role, actorId: value.actorId, principalId: value.binding?.principalId ?? null,
        actorStatus: value.binding?.actor.status ?? "UNKNOWN",
        source: value.binding ? resolved.get(value.binding.principalId)?.get(value.key) ?? null : null,
      })), executionAuthorityGranted: false };
    return { id: assignment.id, proof, digest: workforceDigest(proof),
      allowed: proof.roles.every(role => role.actorStatus === "CURRENT" && role.source?.allowed === true) };
  });
}
