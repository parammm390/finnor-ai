import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { PoolClient } from "pg";
import type { TenantContext } from "@finnor/shared-types";
import { workforceEmployeeAuthoritySnapshotTx } from "@finnor/authority";
import { affectedClosure } from "../live-recompilation/contracts";
import { readAllocationSnapshotTx } from "../allocation-store";
import { organizationDigest } from "./compiler";
import { readOrganizationEvidenceTx } from "./sources";
import { orgFail, type OrganizationRequestRow } from "./store";

const { sourceURL } = createRequire(import.meta.url)("@finnor/source-custody") as { sourceURL(path: string): string };
const methodPaths = ["contracts", "compiler", "checker", "lifecycle", "evaluation", "sources", "dependencies",
  "native", "native-contracts", "worker", "store", "plan", "population", "bridges", "resource-owners",
  "audience", "packets", "continuation", "native-evaluation", "operational-query", "trials"].map(
  name => "packages/private-equity/src/organization-transformation/" + name + ".ts").concat([
    "packages/epistemic-runtime/src/postz-w5-prospective-trial.ts",
    "packages/epistemic-runtime/src/postz-w5-randomized-effect.ts",
  ]);
export function organizationMethodPins() {
  return methodPaths.map(path => ({ id: path,
    digest: createHash("sha256").update(readFileSync(new URL(sourceURL("finnor-os/" + path)))).digest("hex") }));
}
async function currentActor(ctx: TenantContext, id: string, c: PoolClient) {
  const row = (await c.query(`SELECT u.id,u.status,p.actor_kind,p.version FROM finnor_os.users u
    LEFT JOIN finnor_os.employee_actor_profiles p ON p.tenant_id=u.tenant_id AND p.principal_id=u.id
    WHERE u.tenant_id=$1 AND u.id=$2`, [ctx.tenantId, id])).rows[0];
  return row && row.status === "active" && row.actor_kind ? organizationDigest(row) : null;
}
export async function pinOrganizationDependenciesTx(ctx: TenantContext, q: OrganizationRequestRow, c: PoolClient,
  program: NonNullable<OrganizationRequestRow["program"]>) {
  const processes = q.original.organization.processes.map(p => p.id);
  const pins: Array<{ kind: string; id: string; digest: string; processes: string[] }> = [];
  const source = (ref: { id: string; contentDigest: string }, ids: string[]) =>
    pins.push({ kind: "S1", id: ref.id, digest: ref.contentDigest, processes: ids });
  source(q.original.organization.ref, processes); source(q.original.mandate.ref, processes);
  for (const ref of q.original.organization.sourceRefs) {
    const observed = q.original.organization.observations.filter(o => o.evidenceRefs.some(r => r.id === ref.id)).map(o => o.processId);
    source(ref, observed.length ? observed : processes);
  }
  for (const obs of q.original.organization.observations) for (const ref of obs.evidenceRefs) source(ref, [obs.processId]);
  for (const role of q.original.organization.roles) {
    const digest = await currentActor(ctx, role.principalId, c);
    if (!digest) orgFail("W5_CURRENT_ROLE_PIN_REQUIRED");
    pins.push({ kind: "ACTOR", id: role.principalId, digest, processes: q.original.organization.processes
      .filter(p => p.nodes.some(n => n.roleId === role.id) || program.alternatives.some(a =>
        a.processes.some(candidate => candidate.id === p.id && candidate.nodes.some(n => n.roleId === role.id)))).map(p => p.id) });
  }
  const standing = await workforceEmployeeAuthoritySnapshotTx(ctx, c);
  pins.push({ kind: "AUTHORITY", id: q.principal_id, digest: organizationDigest(standing), processes });
  for (const resource of q.budget.resources) pins.push({ kind: "S5_RESOURCE", id: resource.resourceId, digest: resource.ref.contentDigest, processes });
  for (const method of organizationMethodPins()) pins.push({ kind: "METHOD", id: method.id, digest: method.digest, processes });
  const merged = new Map<string, typeof pins[number]>();
  for (const pin of pins) {
    const key = pin.kind + ":" + pin.id, previous = merged.get(key);
    if (previous && previous.digest !== pin.digest) orgFail("W5_DEPENDENCY_PREIMAGE_CONFLICT");
    merged.set(key, { ...pin, processes: [...new Set([...(previous?.processes ?? []), ...pin.processes])].sort() });
  }
  if (merged.size > 4096) orgFail("W5_DEPENDENCY_PIN_BOUND");
  for (const pin of merged.values()) await c.query(`INSERT INTO finnor_os.w5_dependency_pins
    (tenant_id,request_id,principal_id,kind,source_id,digest,process_ids) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [ctx.tenantId, q.id, q.principal_id, pin.kind, pin.id, pin.digest, JSON.stringify(pin.processes)]);
}
export async function inspectOrganizationDependenciesTx(ctx: TenantContext, q: OrganizationRequestRow, c: PoolClient) {
  const pins = (await c.query(`SELECT kind,source_id,digest,process_ids FROM finnor_os.w5_dependency_pins
    WHERE tenant_id=$1 AND request_id=$2 ORDER BY kind,source_id LIMIT 4097`, [ctx.tenantId, q.id])).rows;
  if (pins.length > 4096 || q.program && !pins.length) orgFail("W5_COMPLETE_ORIGINAL_DEPENDENCY_POPULATION_REQUIRED");
  const methods = new Map(organizationMethodPins().map(p => [p.id, p.digest]));
  const resources = pins.some(p => p.kind === "S5_RESOURCE") ? await readAllocationSnapshotTx({ auth: ctx }, c) : null;
  const standing = pins.some(p => p.kind === "AUTHORITY") ? await workforceEmployeeAuthoritySnapshotTx(ctx, c) : null;
  const invalidations: Array<{ kind: string; id: string; expectedDigest: string; actualDigest: string | null; processIds: string[] }> = [];
  for (const pin of pins) {
    let actual: string | null = null;
    if (pin.kind === "S1") {
      const row = (await c.query(`SELECT v.content_hash,v.version_number,
        (SELECT max(n.version_number) FROM finnor_os.evidence_source_versions n WHERE n.tenant_id=v.tenant_id AND n.source_id=v.source_id) latest
        FROM finnor_os.evidence_source_versions v WHERE v.tenant_id=$1 AND v.id=$2`, [ctx.tenantId, pin.source_id])).rows[0];
      if (row) {
        try { const source = await readOrganizationEvidenceTx(ctx, { owner: "S1", id: pin.source_id,
          version: String(row.version_number), contentDigest: pin.digest }, c);
          actual = source.version_number === row.latest ? source.content_hash : null;
        } catch { actual = null; }
      }
    } else if (pin.kind === "ACTOR") actual = await currentActor(ctx, pin.source_id, c);
    else if (pin.kind === "AUTHORITY") actual = organizationDigest(standing);
    else if (pin.kind === "METHOD") actual = methods.get(pin.source_id) ?? null;
    else if (pin.kind === "S5_RESOURCE") {
      const resource = resources?.resources.find(r => r.resourceId === pin.source_id && !r.revoked && Date.parse(r.validUntil) > Date.now());
      actual = resource?.ref.contentDigest ?? null;
    }
    if (actual !== pin.digest) invalidations.push({ kind: pin.kind, id: pin.source_id, expectedDigest: pin.digest,
      actualDigest: actual, processIds: pin.process_ids });
  }
  const processes = q.original.organization.processes.map(p => ({ id: p.id, dependsOn: q.original.organization.obligations
    .filter(o => o.processId === p.id).flatMap(o => q.original.organization.obligations
      .filter(other => other.processId !== p.id && (other.workId === o.workId ||
        other.effectRefs.some(ref => o.effectRefs.some(own => own.id === ref.id)))).map(other => other.processId)) }));
  const seeds = [...new Set(invalidations.flatMap(p => p.processIds))];
  const closure = affectedClosure(processes, seeds);
  return { status: invalidations.length ? "INVALIDATED" as const : "CURRENT" as const, invalidations,
    affectedProcessIds: closure.affectedNodes.map(n => n.id), keptProcessIds: processes
      .filter(p => !closure.affectedNodes.some(n => n.id === p.id)).map(p => p.id),
    originalWorkId: q.work_id, originalDeadline: q.original.mandate.originalDeadline,
    effectsReplayed: false, resourceEnvelopeRenewed: false, qualificationGranted: false };
}
