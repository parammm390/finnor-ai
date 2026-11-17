/** Local fixture configuration only. Never a release, fleet or S8 admission. */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { COMPUTE_CLASSIFICATION_REVISION, COMPUTE_CUTOVER_EPOCH,
  PRODUCTION_JOB_CONTRACTS } from "../../packages/db/compute-contract";
import { assertDisposableDatabaseTarget,
  assertNotProductionDatabaseTarget } from "../../packages/db/production-target-guard";
import type { DisposablePostgresOwner } from "./disposable-postgres.mjs";

const qualification = "LOCAL_QUEUE_CLASS_CONFIGURATION_NOT_DEPLOYMENT_OR_S8_ADMISSION";
const types = ["run_harness_program_v1", "run_evidence_derivation_v1", "run_compute_search_unit_v1"] as const;
type Artifact = (name: string, value: unknown) => Promise<void>;
interface Plane {
  state: string; accepted_job_epoch: number; minimum_claim_epoch: number;
  enforce_known_job_types: boolean; legacy_tenant_writes_allowed: boolean;
  activated_release_sha: string | null; activated_at: string | null; updated_at: string;
}
interface ClaimCut {
  cutover: Plane; eligible_native_jobs: number; deliveries: number; physical_attempts: number;
}

export async function bootstrapDisposableComputePlane(
  e: { admin: Client; repo: string; disposablePostgres: DisposablePostgresOwner },
  refusingQueue: { tick(): Promise<unknown>; registeredTypes(): string[]; identity: { scheduler: { workloadClass: string | null } } },
  tenant: string, artifact: Artifact,
) {
  assert(process.env.NODE_ENV === "test" && process.env.FINNOR_P4_PROFILE === "ordinary_disposable" &&
    process.env.FINNOR_W1_NATIVE_STORY === "internal-pressure", "W1_EXPLICIT_DISPOSABLE_PRESSURE_ONLY");
  assert(typeof process.getuid === "function", "W1_UNIX_DISPOSABLE_OWNER_REQUIRED");
  const { admin } = e, owner = e.disposablePostgres?.observation;
  assert(owner?.schema === "finnor.w1.disposable-postgres-owner.v1" && owner.ownerPid === process.pid &&
    owner.uid === process.getuid() && owner.status === "NOT_CLEANED" &&
    !owner.clusterStopped && !owner.directoryRemoved, "W1_LIVE_OWNED_POSTGRES_REQUIRED");
  assert.equal(admin.host, "127.0.0.1");
  assert.equal(admin.user, "finnor");
  assert.equal(admin.database, "p4_e2e");
  assert(Number.isSafeInteger(admin.port) && admin.port > 1024 && admin.port <= 65535);
  const target = `postgres://${admin.user}@${admin.host}:${admin.port}/${admin.database}`;
  for (const [url, role] of [[target, "finnor"], [process.env.DATABASE_URL, "finnor_app"],
    [process.env.FINNOR_P2_WORKER_DATABASE_URL, "finnor_worker"]] as const) {
    assertNotProductionDatabaseTarget(url, "W1 local compute bootstrap");
    assertDisposableDatabaseTarget(url, "W1 local compute bootstrap");
    const parsed = new URL(url);
    assert(parsed.protocol === "postgres:" || parsed.protocol === "postgresql:");
    assert.equal(parsed.hostname, admin.host); assert.equal(Number(parsed.port), admin.port);
    assert.equal(parsed.pathname, "/p4_e2e"); assert.equal(decodeURIComponent(parsed.username), role);
  }
  assert(!admin.ssl && admin.connection.stream instanceof Socket &&
    admin.connection.stream.remoteAddress === admin.host &&
    admin.connection.stream.remotePort === admin.port, "W1_ACTUAL_LOOPBACK_ADMIN_SOCKET_REQUIRED");
  assert.equal(await realpath(owner.directory), owner.directory);
  assert.equal(owner.databaseDirectory, owner.directory);
  const stat = await lstat(owner.directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === owner.uid &&
    stat.dev === owner.dev && stat.ino === owner.ino, "W1_POSTGRES_CUSTODY_CHANGED");
  const server = (await admin.query(`SELECT host(inet_server_addr()) host,inet_server_port() port,
    current_database() database,current_setting('data_directory') directory`)).rows[0];
  assert(server?.host === admin.host && server.port === admin.port && server.database === admin.database &&
    await realpath(server.directory) === owner.databaseDirectory, "W1_ACTUAL_OWNED_CLUSTER_REQUIRED");
  const repo = await realpath(e.repo);
  assert.equal(repo, await realpath(fileURLToPath(new URL("../../../", import.meta.url))));
  const git = spawnSync("git", ["-C", repo, "rev-parse", "--verify", "HEAD^{commit}"],
    { encoding: "utf8", timeout: 3000, maxBuffer: 4096 });
  const head = git.stdout?.trim();
  assert(git.status === 0 && head && /^[0-9a-f]{40}$/.test(head), "W1_REAL_CHECKOUT_HEAD_REQUIRED");
  assert.equal(COMPUTE_CUTOVER_EPOCH, 3);
  assert.equal(refusingQueue.identity.scheduler.workloadClass, "INTERACTIVE");
  assert(types.every(type => refusingQueue.registeredTypes().includes(type)));
  const cut = async () => (await admin.query<ClaimCut>(`SELECT to_jsonb(c) cutover,
    (SELECT count(*)::int FROM finnor_os.jobs WHERE tenant_id=$1 AND status='queued'
      AND run_at<=clock_timestamp() AND type='run_compute_search_unit_v1' AND protocol_version=3) eligible_native_jobs,
    (SELECT count(*)::int FROM finnor_os.job_delivery_attempts WHERE tenant_id=$1) deliveries,
    (SELECT count(*)::int FROM finnor_os.p2_attempts WHERE tenant_id=$1) physical_attempts
    FROM finnor_os.compute_plane_cutover c WHERE singleton=true`, [tenant])).rows[0];
  const before = await cut();
  assert(before && before.cutover.state === "preparing" && before.eligible_native_jobs > 0,
    "W1_PREPARING_REFUSAL_REQUIRES_REAL_DUE_NATIVE_WORK");
  assert.equal(before.physical_attempts, 0);
  const refused = await refusingQueue.tick(), afterRefusal = await cut();
  await artifact("disposable-compute-preparing-refusal.json", {
    qualification, before, refused, afterRefusal, workerIdentity: refusingQueue.identity,
  });
  assert.equal(refused, false, "The original preparing plane must refuse class claims");
  assert(afterRefusal, "W1_PREPARING_REFUSAL_CUT_REQUIRED");
  assert.deepEqual(afterRefusal.cutover, before.cutover);
  assert.equal(afterRefusal.deliveries, before.deliveries);
  assert.equal(afterRefusal.physical_attempts, before.physical_attempts);
  const policies = (await admin.query(`SELECT job_type,active,default_class,allowed_classes,
    classification_rule,tenant_scope,obligation_kind,policy_revision
    FROM finnor_os.compute_job_type_policies WHERE job_type=ANY($1::text[]) ORDER BY job_type`, [types])).rows;
  assert.equal(policies.length, types.length);
  for (const type of types) {
    const policy = policies.find(row => row.job_type === type), expected = PRODUCTION_JOB_CONTRACTS[type];
    assert(policy?.active && policy.default_class === expected.defaultClass &&
      policy.classification_rule === expected.classificationRule && policy.tenant_scope === expected.tenantScope &&
      policy.obligation_kind === expected.obligationKind && policy.policy_revision === COMPUTE_CLASSIFICATION_REVISION);
    assert.deepEqual(policy.allowed_classes, expected.allowedClasses);
  }
  const previous = before.cutover;
  assert.equal(previous.activated_at, null);
  const changed = await admin.query(`UPDATE finnor_os.compute_plane_cutover SET state='authoritative',
    accepted_job_epoch=$1,minimum_claim_epoch=$1,enforce_known_job_types=true,legacy_tenant_writes_allowed=false,
    activated_release_sha=$2,activated_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE singleton=true AND state='preparing' AND accepted_job_epoch=$3 AND minimum_claim_epoch=$4
      AND enforce_known_job_types=$5 AND legacy_tenant_writes_allowed=$6
      AND activated_release_sha IS NOT DISTINCT FROM $7::text AND activated_at IS NULL AND updated_at=$8::timestamptz
    RETURNING to_jsonb(compute_plane_cutover) body`, [COMPUTE_CUTOVER_EPOCH, head,
    previous.accepted_job_epoch, previous.minimum_claim_epoch, previous.enforce_known_job_types,
    previous.legacy_tenant_writes_allowed, previous.activated_release_sha, previous.updated_at]);
  const observation = { qualification, head, epoch: COMPUTE_CUTOVER_EPOCH, before,
    after: changed.rows[0]?.body ?? null, changedRows: changed.rowCount, policies,
    ownedPostgresId: owner.id, headIsReleaseAttestation: false,
    workingSourceHashes: "SEPARATELY_RECORDED_BY_ORIGINAL_OWNING_DRIVER" };
  await artifact("disposable-compute-bootstrap.json", observation);
  assert.equal(changed.rowCount, 1, "W1_DISPOSABLE_PREPARING_COMPARE_AND_SET_REQUIRED");
  assert.equal(observation.after.state, "authoritative");
  assert.equal(observation.after.activated_release_sha, head);
  return observation;
}
