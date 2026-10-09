import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import type { PeMutationContext, PeWorldRootRef } from "../types";
import { authorize, principal, revisions, sameRevisions, schemaIdentity, tx, unavailable } from "../evidence-execution/store";
import { hash, stable, bytesHash } from "./exact";
import type { R4Profile, R4RunRow } from "./contracts";

const root = resolve(import.meta.dirname, "../../../../..");
const files = [
  "packages/epistemic-runtime/src/identification-plan/producer.py",
  "packages/epistemic-runtime/src/identification-plan/checker.py",
  "packages/epistemic-runtime/src/identification-plan/supervisor.py",
  "packages/shared-types/src/identification-plan.ts",
  "packages/private-equity/src/r4/contracts.ts", "packages/private-equity/src/r4/exact.ts",
  "packages/private-equity/src/r4/store.ts", "packages/private-equity/src/r4/owners.ts",
  "packages/private-equity/src/r4/api.ts", "packages/private-equity/src/r4/worker.ts",
  "packages/private-equity/src/r4/native.ts", "packages/private-equity/src/r4/schema.sql",
  "packages/private-equity/src/r4/owner-adapters.ts",
  "packages/private-equity/src/r4/view.ts",
  "packages/private-equity/src/enterprise-beliefs.ts", "packages/private-equity/src/enterprise-experiments.ts",
  "packages/private-equity/src/enterprise-interventions.ts", "packages/private-equity/src/enterprise-control.ts",
  "packages/private-equity/src/enterprise-allocation.ts", "packages/private-equity/src/enterprise-economic-attribution.ts",
  "packages/db/compute-contract.ts", "packages/db/compute-governor.ts",
  "apps/worker/src/queue.ts", "apps/worker/src/index.ts",
  "scripts/r4/requirements.lock", "package-lock.json",
].map(p => "finnor-os/" + p);

async function currentRuntime() {
  const python = process.env.FINNOR_R4_PYTHON;
  if (!python || !python.startsWith("/")) throw Error("R4_APPLICATION_OWNED_PYTHON_UNCONFIGURED");
  const digests = await Promise.all(files.map(async path => ({ path, sha256: bytesHash(await readFile(resolve(root, path))) })));
  const executableDigest = bytesHash(await readFile(python));
  return { digest: hash({ files: digests, python, executableDigest, node: process.version }),
    files: digests, python, executableDigest };
}
// Pin on first owner use, then compare actual bytes before claim/publication/use.
let loaded: ReturnType<typeof currentRuntime> | undefined;
export async function runtimeIdentity() {
  loaded ??= currentRuntime();
  const pinned = await loaded;
  if (pinned.digest !== (await currentRuntime()).digest) throw Error("R4_LOADED_RUNTIME_METHOD_OR_CHECKER_CHANGED");
  return pinned;
}

export async function workCut(ctx: PeMutationContext, rootRef: PeWorldRootRef, workId: string, inputId?: string, c?: PoolClient, lock = false) {
  if (!c) await authorize(ctx, rootRef, [{ type: "work", id: workId }]);
  const read = async (client: PoolClient) => {
    const user = (await client.query("SELECT role,status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2" + (lock ? " FOR SHARE" : ""), [ctx.auth.tenantId, principal(ctx)])).rows[0];
    if (user?.status !== "active" || user.role !== "owner") throw unavailable();
    const work = (await client.query("SELECT id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2" + (lock ? " FOR SHARE" : ""), [ctx.auth.tenantId, workId])).rows[0];
    if (!work) throw unavailable();
    const input = (await client.query("SELECT id,to_jsonb(w) body FROM finnor_os.work_inputs w WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [ctx.auth.tenantId, workId])).rows[0];
    if (!input || inputId && inputId !== input.id) throw Error("R4_CANONICAL_WORK_INPUT_REVISED");
    return { id: input.id as string, digest: hash(input.body) };
  };
  return c ? read(c) : tx(ctx, read, true);
}
export async function profile(ctx: PeMutationContext, id: string, c?: PoolClient): Promise<R4Profile> {
  const read = async (client: PoolClient) => {
    const r = (await client.query("SELECT body,digest FROM finnor_os.r4_profiles WHERE tenant_id=$1 AND principal_id=$2 AND id=$3", [ctx.auth.tenantId, principal(ctx), id])).rows[0];
    if (!r || hash(r.body) !== r.digest) throw unavailable();
    return r.body as R4Profile;
  };
  return c ? read(c) : tx(ctx, read, true);
}
export async function runRow(ctx: PeMutationContext, id: string, c?: PoolClient, lock = false): Promise<R4RunRow> {
  const read = async (client: PoolClient) => {
    const r = (await client.query<R4RunRow>("SELECT * FROM finnor_os.r4_runs WHERE tenant_id=$1 AND principal_id=$2 AND id=$3" + (lock ? " FOR UPDATE" : ""), [ctx.auth.tenantId, principal(ctx), id])).rows[0];
    if (!r || hash(r.request) !== r.request_digest) throw unavailable();
    return r;
  };
  return c ? read(c) : tx(ctx, read, true);
}
export async function append(ctx: PeMutationContext, id: string, kind: string, body: unknown, c?: PoolClient) {
  const write = (client: PoolClient) => client.query("INSERT INTO finnor_os.r4_history(tenant_id,principal_id,run_id,kind,body,digest) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
    [ctx.auth.tenantId, principal(ctx), id, kind, stable(body), hash(body)]);
  return c ? write(c) : tx(ctx, write);
}
export async function artifact(ctx: PeMutationContext, runId: string, kind: string, body: unknown, c?: PoolClient) {
  const id = randomUUID();
  const write = async (client: PoolClient) => {
    await client.query("INSERT INTO finnor_os.r4_artifacts(id,tenant_id,principal_id,run_id,kind,body,digest) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)",
      [id, ctx.auth.tenantId, principal(ctx), runId, kind, stable(body), hash(body)]);
    return { owner: "R4", id, version: "r4-artifact-v1", contentDigest: hash(body) };
  };
  return c ? write(c) : tx(ctx, write);
}
export async function readArtifact(ctx: PeMutationContext, id: string, c?: PoolClient) {
  const read = async (client: PoolClient) => {
    const r = (await client.query("SELECT body,digest FROM finnor_os.r4_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND id=$3", [ctx.auth.tenantId, principal(ctx), id])).rows[0];
    if (!r || hash(r.body) !== r.digest) throw unavailable();
    return r.body;
  };
  return c ? read(c) : tx(ctx, read, true);
}
export async function currentLocal(ctx: PeMutationContext, p: R4Profile, c?: PoolClient, lock = false) {
  const work = await workCut(ctx, p.root, p.workId, p.workInputId, c, lock);
  if (work.digest !== p.workInputDigest) throw Error("R4_WORK_PREIMAGE_CHANGED");
  const read = async (client: PoolClient) => {
    const head = (await client.query("SELECT profile_id FROM finnor_os.r4_profile_heads WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3" + (lock ? " FOR SHARE" : ""), [ctx.auth.tenantId, principal(ctx), p.workId])).rows[0];
    if (head?.profile_id !== p.id) throw Error("R4_GRAPH_QUERY_MENU_DATA_PROFILE_REVISED");
    const now = await revisions(ctx, p.dependencies.map(d => d.key), client, lock);
    if (!sameRevisions(p.dependencies.map(d => ({ ...d, nodeIds: [], digest: null })), now)) throw Error("R4_DEPENDENCY_REVISED");
  };
  if (c) await read(c); else await tx(ctx, read, true);
  if (p.runtime.digest !== (await runtimeIdentity()).digest) throw Error("R4_METHOD_CHECKER_OR_LOCK_CHANGED");
  if (!c && p.schemaDigest !== await schemaIdentity(ctx)) throw Error("R4_SCHEMA_CHANGED");
}
export async function invalidate(ctx: PeMutationContext, run: R4RunRow, reason: string) {
  await tx(ctx, async c => {
    const locked = await runRow(ctx, run.id, c, true);
    if (["INVALIDATED", "CANCELLED"].includes(locked.status)) return;
    await c.query("UPDATE finnor_os.r4_runs SET status='INVALIDATED',generation=generation+1,failure=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3", [ctx.auth.tenantId, principal(ctx), run.id, reason]);
    await append(ctx, run.id, "INVALIDATED", { reason, originalEpisode: run.episode_id, costsRetained: true, physicalRetryGranted: false }, c);
  });
}
export async function costs(ctx: PeMutationContext, id: string) {
  return tx(ctx, async c => {
    const r = (await c.query("SELECT id,kind,status,body,digest FROM finnor_os.r4_attempts WHERE tenant_id=$1 AND principal_id=$2 AND run_id=$3 ORDER BY created_at,id", [ctx.auth.tenantId, principal(ctx), id])).rows;
    return { actualComputeUSD: null, actualAcquisitionUSD: null, status: "MATERIAL_METERS_INCOMPLETE", attempts: r.map(a => ({
      id: a.id, kind: a.kind, status: a.status, receiptDigest: a.digest, elapsedMs: a.body.elapsedMs ?? null,
      cpuMicros: a.body.cpuMicros ?? null, peakRssBytes: a.body.peakRssBytes ?? null,
      pid: a.body.pid ?? null, terminationObserved: a.body.terminationObserved ?? false,
      chargedNativeAttempts: a.body.chargedNativeAttempts, originalDeadline: a.body.originalDeadline,
      responsibility: ["INTENT", "SUBMITTED", "UNKNOWN"].includes(a.status) ? "RECONCILE_UNKNOWN_NO_REFUND" : "RETAIN_COST",
    })) };
  }, true);
}
