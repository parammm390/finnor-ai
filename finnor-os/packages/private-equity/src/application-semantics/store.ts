/** Native scoped artifacts and run projections. S5/S6, not this projection,
 * decide occupation, possible effects and independently observed settlement. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { NATIVE_APPLICATION_PROFILE_AUTHORITY_SQL } from "@finnor/db";
import type {
  ApplicationActionModel, ApplicationModelCheck, ExperimentRef, Role,
} from "@finnor/shared-types";
import { resolveApplicationOperationProfile } from "@finnor/security";
import type { PeMutationContext, PeWorldRootRef } from "../types";
import { authorize, principal, schemaIdentity, tx, unavailable } from "../evidence-execution/store";
import { enqueueOwnerDeliveryInTransaction } from "../../../governed-execution/src/owner-delivery-store";
import type { AuthorizedApplicationProfile, OriginalApplicationParent } from "./ports";
import type { ApplicationAcquireRequest, ApplicationExecuteRequest } from "./native-contracts";
import { applicationRuntimeIdentity, parseApplicationCheck, parseApplicationModel, sameX2Ref, x2ByteDigest, x2Digest, x2Fault, x2Ref } from "./contracts";

export interface ApplicationSessionRow {
  id: string; tenant_id: string; principal_id: string; work_id: string; root: PeWorldRootRef;
  work_input_id: string; work_input_digest: string; parent_id: string;
  original_parent_ref: ExperimentRef; parent: OriginalApplicationParent; profile_ids: string[];
  request: ApplicationAcquireRequest | ApplicationExecuteRequest; request_digest: string;
  idempotency_key: string; rights_revision: number | string;
  allocation_ref: ExperimentRef; reservation_ref: ExperimentRef; root_consumption_ref: ExperimentRef;
  status: string; reason: string | null; generation: number;
  model_ref: ExperimentRef | null; check_ref: ExperimentRef | null; composition_ref: ExperimentRef | null;
  claim_token: string | null; claim_fence: string | number | null;
  deadline_at: Date; cancel_requested_at: Date | null; started_at: Date | null;
  finished_at: Date | null; created_at: Date; updated_at: Date;
}
export interface NativeApplicationProfile {
  profile: AuthorizedApplicationProfile;
  authProfileRef: string;
  applicationAccountId: string;
  allowedEntities: string[];
  bindingDigest: string;
  privateProfileBinding: Record<string, unknown>;
  grantBody: Record<string, unknown>;
}
export const APPLICATION_SOURCE_FILES = [
  "finnor-os/packages/shared-types/src/application-semantics.ts",
  ...["contracts", "native-contracts", "ports", "envelope", "learner", "checker", "composition",
    "source", "schema-pattern", "observation", "store", "allocation", "obligations", "runtime", "worker", "api", "validity", "fresh-authority"]
    .map((name) => `finnor-os/packages/private-equity/src/application-semantics/${name}.ts`),
  "finnor-os/packages/computer/src/application-provider.ts",
  "finnor-os/packages/computer/src/application-passive-document.ts",
  "finnor-os/packages/computer/src/broker.ts",
  "finnor-os/packages/governed-execution/src/adapter-contract.ts",
  "finnor-os/packages/security/src/identity-access.ts",
  "finnor-os/packages/security/src/tenant-credentials.ts",
  "finnor-os/packages/private-equity/src/allocation-store.ts",
  "finnor-os/packages/private-equity/src/enterprise-control.ts",
  "finnor-os/packages/private-equity/src/enterprise-allocation.ts",
  "finnor-os/packages/private-equity/src/enterprise-obligations.ts",
  "finnor-os/packages/private-equity/src/program-synthesis/owners.ts",
  "finnor-os/packages/private-equity/src/program-synthesis/contracts.ts",
  "finnor-os/packages/private-equity/src/live-recompilation/contracts.ts",
  "finnor-os/packages/capability-evolution/src/application-semantics-port.ts",
  "finnor-os/packages/capability-evolution/src/application-semantics-consumer.ts",
  "finnor-os/packages/capability-evolution/src/lifecycle.ts",
  "finnor-os/apps/api/app/api/company-brain/[operation]/route.ts",
  "finnor-os/apps/worker/src/index.ts", "finnor-os/apps/worker/src/queue.ts",
  "finnor-os/packages/db/compute-contract.ts",
  "finnor-os/packages/db/governed-egress.ts",
  "finnor-os/packages/orchestration/src/compiler.ts",
  "finnor-os/packages/governed-execution/src/owner-delivery-store.ts",
  "finnor-os/packages/governed-execution/src/owner-transport.ts",
  "finnor-os/packages/private-equity/src/enterprise-beliefs.ts",
  "finnor-os/packages/db/migrations/0191_frontier5_x2_application_semantics.sql",
  "finnor-os/packages/db/migrations/0192_frontier5_x2_request_custody.sql",
  "finnor-os/packages/db/migrations/0193_frontier5_x2_authority_custody.sql",
  "finnor-os/packages/db/migrate.ts",
  "finnor-os/packages/db/migrations/0194_x_phase_charge_phase_union.sql",
  "package-lock.json", "finnor-os/package-lock.json",
] as const;
const sourceRoot = () => process.env.FINNOR_X2_SOURCE_ROOT
  ? resolve(process.env.FINNOR_X2_SOURCE_ROOT) : resolve(import.meta.dirname, "../../../../..");
export async function applicationCodeIdentity() {
  const pins = await Promise.all(APPLICATION_SOURCE_FILES.map(async (path) =>
    ({ path, sha256: x2ByteDigest(await readFile(resolve(sourceRoot(), path))) })));
  const lockDigest = x2Digest(pins.filter((pin) => pin.path.endsWith("package-lock.json")));
  const runtime = applicationRuntimeIdentity();
  return { pins, lockDigest, runtime, digest: x2Digest({ pins, runtime }), runtimeDigest: x2Digest(runtime) };
}
let loadedCut: ReturnType<typeof applicationCodeIdentity> | null = null;
export async function pinnedApplicationCode() {
  loadedCut ??= applicationCodeIdentity();
  const loaded = await loadedCut;
  if (loaded.digest !== (await applicationCodeIdentity()).digest) x2Fault("X2_LOADED_SOURCE_CHANGED");
  return loaded;
}
export async function applicationSession(ctx: PeMutationContext, id: string, client?: PoolClient, lock = false) {
  const read = async (c: PoolClient) => {
    const row = (await c.query<ApplicationSessionRow>("SELECT * FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND principal_id=$2 AND id=$3"
      + (lock ? " FOR UPDATE" : ""), [ctx.auth.tenantId, principal(ctx), id])).rows[0];
    if (!row) throw unavailable();
    if (x2Digest(row.request) !== row.request_digest || !sameX2Ref(row.original_parent_ref, row.parent.originalParentRef)
      || row.parent.deadlineAt !== row.deadline_at.toISOString()) x2Fault("X2_CANONICAL_ORIGINAL_SESSION_INTEGRITY");
    return row;
  };
  return client ? read(client) : tx(ctx, read, true);
}
export async function applicationArtifact<T>(ctx: PeMutationContext, ref: ExperimentRef, client?: PoolClient): Promise<T> {
  const read = async (c: PoolClient) => {
    const row = (await c.query<{ body: T; semantic_owner: string; version: string; content_digest: string }>(
      "SELECT body,semantic_owner,version,content_digest FROM finnor_os.application_semantics_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND artifact_id=$3",
      [ctx.auth.tenantId, principal(ctx), ref.id])).rows[0];
    if (!row || row.semantic_owner !== ref.owner || row.version !== ref.version || row.content_digest !== ref.contentDigest
      || x2Digest(row.body) !== ref.contentDigest) x2Fault("X2_CANONICAL_ARTIFACT_INTEGRITY");
    return row.body;
  };
  return client ? read(client) : tx(ctx, read, true);
}
export async function retainApplicationArtifact(ctx: PeMutationContext, ref: ExperimentRef, body: unknown,
  privateBody = false, client?: PoolClient, rightsRefs: readonly string[] = []): Promise<void> {
  if (x2Digest(body) !== ref.contentDigest || Buffer.byteLength(JSON.stringify(body)) > 2 * 1024 * 1024) {
    x2Fault("X2_OWNER_ARTIFACT_PREIMAGE");
  }
  const write = async (c: PoolClient) => {
    const prior = (await c.query<{ body: unknown; private: boolean }>(
      "SELECT body,private FROM finnor_os.application_semantics_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND artifact_id=$3",
      [ctx.auth.tenantId, principal(ctx), ref.id])).rows[0];
    if (prior && (x2Digest(prior.body) !== ref.contentDigest || prior.private !== privateBody)) x2Fault("X2_OWNER_ARTIFACT_CONFLICT");
    if (!prior) await c.query(
      "INSERT INTO finnor_os.application_semantics_artifacts(tenant_id,principal_id,artifact_id,semantic_owner,version,content_digest,private,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
      [ctx.auth.tenantId, principal(ctx), ref.id, ref.owner, ref.version, ref.contentDigest, privateBody, JSON.stringify(body)]);
    if (!privateBody && rightsRefs.length) await enqueueOwnerDeliveryInTransaction(c, {
      semanticOwner: ref.owner, tenantId: ctx.auth.tenantId, principalId: principal(ctx),
    }, { kind: "REFERENCE", identity: ref.id, payload: { reference: { ...ref, content: body }, rightsRefs } });
  };
  if (client) await write(client); else await tx(ctx, write);
}
export async function applicationEvent(ctx: PeMutationContext, session: ApplicationSessionRow, kind: string,
  detail: unknown, client?: PoolClient): Promise<ExperimentRef> {
  const body = { schema: "finnor.x2.native-event.v1", tenantId: session.tenant_id, principalId: session.principal_id,
    sessionId: session.id, originalParentRef: session.original_parent_ref, generation: session.generation,
    kind, detail, observedAt: new Date().toISOString(), protectedReceipt: null };
  const ref = x2Ref("S6", "application-native-event", body);
  const write = async (c: PoolClient) => {
    await retainApplicationArtifact(ctx, ref, body, false, c, [session.parent.rightsRevision]);
    await c.query("INSERT INTO finnor_os.application_semantics_events(tenant_id,principal_id,session_id,event_id,kind,body) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING",
      [session.tenant_id, session.principal_id, session.id, ref.id, kind, JSON.stringify(body)]);
  };
  if (client) await write(client); else await tx(ctx, write);
  return ref;
}
export async function currentApplicationWork(ctx: PeMutationContext, row: ApplicationSessionRow, client?: PoolClient,
  recovery = false): Promise<void> {
  if (ctx.auth.role !== "owner" || principal(ctx) !== ctx.auth.userId) throw unavailable();
  const rights = await authorize(ctx, row.root, [{ type: "work", id: row.work_id }]);
  if (!Number.isSafeInteger(Number(row.rights_revision)) || rights.revision !== Number(row.rights_revision)) x2Fault("X2_CURRENT_S1_RIGHTS_CHANGED");
  const read = async (c: PoolClient) => {
    const actor = await c.query("SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND status='active' AND role='owner' FOR SHARE",
      [ctx.auth.tenantId, principal(ctx)]);
    if (actor.rowCount !== 1) x2Fault("X2_CURRENT_ACTOR_OR_WORK_INPUT_CHANGED");
    // Intake inserts its new input before locking Work. Read inputs only after
    // this lock so a writer that committed while we waited cannot be missed.
    const work = (await c.query<{ status: string }>(
      "SELECT status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE",
      [ctx.auth.tenantId, row.work_id])).rows[0];
    const input = (await c.query<{ id: string; body: unknown }>(
      "SELECT id::text,to_jsonb(w) body FROM finnor_os.work_inputs w WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
      [ctx.auth.tenantId, row.work_id])).rows[0];
    if (input?.id !== row.work_input_id || x2Digest(input.body) !== row.work_input_digest) x2Fault("X2_CURRENT_ACTOR_OR_WORK_INPUT_CHANGED");
    if (!work || !recovery && ["cancelled", "failed"].includes(work.status)) x2Fault("X2_CURRENT_WORK_CANCELLED_OR_FAILED");
    if (!recovery && (row.cancel_requested_at || ["CANCELLED", "STALE", "BLOCKED"].includes(row.status)
      || row.deadline_at.getTime() <= Date.now())) x2Fault("X2_ORIGINAL_CANCELLED_STALE_OR_EXPIRED");
  };
  if (client) await read(client); else await tx(ctx, read);
  if (!recovery) {
    const code = await pinnedApplicationCode();
    if (row.parent.runtimeDigest !== code.runtimeDigest || row.parent.dependencyLockDigest !== code.lockDigest
      || x2Digest(row.parent.dependencyPins) !== x2Digest(code.pins)) x2Fault("X2_CURRENT_RUNTIME_OR_SOURCE_CHANGED");
    if (row.parent.schemaDigest !== await schemaIdentity(ctx)) x2Fault("X2_CURRENT_SCHEMA_CHANGED");
    if (row.parent_id !== row.id) {
      const parent = await applicationSession(ctx, row.parent_id, client);
      if (!sameX2Ref(parent.original_parent_ref, row.original_parent_ref)
        || !sameX2Ref(parent.allocation_ref, row.allocation_ref)) x2Fault("X2_CHILD_ORIGINAL_PARENT_ANCESTRY");
      await currentApplicationWork(ctx, parent, client);
    }
  }
}
export async function nativeApplicationProfile(ctx: PeMutationContext, id: string): Promise<NativeApplicationProfile> {
  const selected = await tx(ctx, async (c) => (await c.query<{
    auth_profile_ref: string; application: string; connection_revision: number; updated_at: Date;
    private_binding: Record<string, unknown>;
  }>(`SELECT p.auth_profile_ref,a.application,p.connection_revision,p.updated_at,${NATIVE_APPLICATION_PROFILE_AUTHORITY_SQL} private_binding FROM finnor_os.auth_profiles p JOIN finnor_os.application_accounts a ON a.tenant_id=p.tenant_id AND a.id=p.application_account_id WHERE p.tenant_id=$1 AND p.id=$2`,
  [ctx.auth.tenantId, id])).rows[0], true);
  if (!selected) throw unavailable();
  const access = await resolveApplicationOperationProfile(ctx.auth.tenantId, principal(ctx), selected.application, selected.auth_profile_ref);
  const config = access.restrictions.applicationSemantics;
  if (!config || typeof config !== "object" || Array.isArray(config)) x2Fault("X2_EXACT_AUTH_PROFILE_DOMAIN_REQUIRED");
  const data = config as Record<string, unknown>;
  const string = (key: string, optional = false) => {
    if (optional && data[key] === null) return null;
    if (typeof data[key] !== "string" || !(data[key] as string).length || (data[key] as string).length > 2048) x2Fault("X2_PROFILE_CONTRACT_INVALID");
    return data[key] as string;
  };
  const strings = (key: string, maximum: number, minimum = 1) => {
    const value = data[key];
    if (!Array.isArray(value) || value.length < minimum || value.length > maximum
      || value.some((item) => typeof item !== "string" || !item.length || item.length > 1024)) x2Fault("X2_PROFILE_CONTRACT_INVALID");
    return value as string[];
  };
  if (data.sourceContract !== "BOUNDED_CONDITIONAL_APPLICATION_V1" || data.protectionDomain !== "DISPOSABLE_TEST_AUTHORITY"
    || process.env.FINNOR_ENVIRONMENT !== "staging" || process.env.FINNOR_X2_PROFILE !== "ordinary_disposable") x2Fault("X2_PROTECTED_APPLICATION_DOMAIN_UNADMITTED", 403);
  const origin = string("origin")!, url = new URL(origin);
  if (url.origin !== origin || url.username || url.password || url.protocol !== "http:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) x2Fault("X2_DISPOSABLE_ORIGIN_REQUIRED", 403);
  const validUntil = string("validUntil")!;
  if (!Number.isFinite(Date.parse(validUntil)) || Date.parse(validUntil) <= Date.now()) x2Fault("X2_CURRENT_PROFILE_EXPIRED", 403);
  const account = string("account")!;
  if (access.providerAccountRef !== account) x2Fault("X2_PROVIDER_ACCOUNT_BINDING");
  const grant = { profileId: id, tenantId: ctx.auth.tenantId, principalId: principal(ctx),
    accountId: access.applicationAccountId, principalRef: access.principalRef,
    revision: selected.connection_revision, restrictions: access.restrictions, updatedAt: selected.updated_at.toISOString() };
  const profile: AuthorizedApplicationProfile = {
    id, tenantId: ctx.auth.tenantId, principalId: principal(ctx), application: string("application")!,
    account, actingPrincipal: string("actingPrincipal")!, role: string("role")!,
    grantRef: x2Ref("AUTHORITY", "application-profile-grant", grant), origin,
    entrypoint: string("entrypoint")!, documentationPaths: strings("documentationPaths", 8, 0),
    contextPath: string("contextPath", true), recordPathTemplate: string("recordPathTemplate")!,
    requestPathTemplate: string("requestPathTemplate", true), allowedTargets: strings("allowedTargets", 16),
    validUntil, credentials: { headers: { ...access.applicationHeaders } },
    sourceContract: "BOUNDED_CONDITIONAL_APPLICATION_V1", protectionDomain: "DISPOSABLE_TEST_AUTHORITY",
    ...(data.discoverySurface === "API" || data.discoverySurface === "UI" || data.discoverySurface === "HYBRID"
      ? { discoverySurface: data.discoverySurface } : {}),
  };
  return { profile, authProfileRef: access.authProfileRef, applicationAccountId: access.applicationAccountId,
    allowedEntities: strings("allowedEntities", 64), grantBody: grant, privateProfileBinding: selected.private_binding,
    bindingDigest: x2Digest({ grant, privateProfileBinding: selected.private_binding, privateHeaderDigest: x2Digest(access.applicationHeaders) }) };
}
export function assertProfileTarget(profile: NativeApplicationProfile, target: { application: string; account: string; entity: string; id: string }) {
  if (target.application !== profile.profile.application || target.account !== profile.profile.account
    || !profile.profile.allowedTargets.includes(target.id) || !profile.allowedEntities.includes(target.entity)) x2Fault("X2_EXACT_AUTHORIZED_TARGET_REQUIRED", 403);
}
export async function currentApplicationModel(ctx: PeMutationContext, row: ApplicationSessionRow): Promise<{ model: ApplicationActionModel; check: ApplicationModelCheck }> {
  if (!row.model_ref || !row.check_ref) x2Fault("X2_NATIVE_CHECKED_MODEL_REQUIRED");
  const body = await applicationArtifact<Omit<ApplicationActionModel, "ref">>(ctx, row.model_ref);
  const checkBody = await applicationArtifact<Omit<ApplicationModelCheck, "ref">>(ctx, row.check_ref);
  return { model: parseApplicationModel({ ...body, ref: row.model_ref }), check: parseApplicationCheck({ ...checkBody, ref: row.check_ref }) };
}
export async function enqueueApplicationSession(ctx: PeMutationContext, row: ApplicationSessionRow, stage: string, client: PoolClient) {
  await client.query("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety,max_attempts) VALUES($1,'run_application_semantics_v1',$2::jsonb,$3,'interactive',1,'reconcilable',5) ON CONFLICT(idempotency_key) DO NOTHING",
    [ctx.auth.tenantId, JSON.stringify({ tenantId: ctx.auth.tenantId, principalId: principal(ctx), sessionId: row.id, generation: row.generation }),
      `x2:${row.id}:${row.generation}:${stage}`]);
}
export async function canonicalApplicationActor(tenantId: string, principalId: string): Promise<PeMutationContext> {
  const provisional: PeMutationContext = { auth: { tenantId, userId: principalId, employeeId: principalId, role: "owner" } };
  const role = await tx(provisional, async (c) => (await c.query<{ role: Role }>(
    "SELECT role FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND status='active'", [tenantId, principalId])).rows[0]?.role, true);
  if (role !== "owner") throw unavailable();
  return { auth: { tenantId, userId: principalId, employeeId: principalId, role } };
}
