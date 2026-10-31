import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type pg from "pg";

export interface NativeObservationFixture {
  fixture: "P1_LIABILITY_ARITHMETIC"; tenantId: string; principalId: string; programId: string;
}
/** Collects actual original rows. Neither this collector nor its Python oracle imports selection code. */
export async function observeNativeRun(admin: pg.Client, fixture: NativeObservationFixture, searchId: string,
  program: unknown, auth: { bypass: false; anonymousStatus: number; foreignStatus: number }, destination: string) {
  const parent = (await admin.query("SELECT * FROM finnor_os.p1_requests WHERE id=$1 AND tenant_id=$2 AND principal_id=$3",
    [fixture.programId, fixture.tenantId, fixture.principalId])).rows[0];
  assert(parent, "Actual original parent required");
  const search = (await admin.query("SELECT * FROM finnor_os.p2_requests WHERE id=$1 AND tenant_id=$2 AND principal_id=$3",
    [searchId, fixture.tenantId, fixture.principalId])).rows[0];
  assert(search && search.program_id === parent.id, "Exact original parent/search custody required");
  const episode = (await admin.query("SELECT * FROM finnor_os.p1_episodes WHERE id=$1", [parent.episode_id])).rows[0];
  const rows = async (table: string) => (await admin.query(`SELECT * FROM finnor_os.${table} WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 ORDER BY created_at,id`,
    [fixture.tenantId, fixture.principalId, searchId])).rows;
  const [attempts, units, events, responses, capsules, developmentChecks, nativeStageObservations, continuationStates,
    measurementGaps, continuationSourceAttempts, continuationSourceEvents] = await Promise.all([
    rows("p2_attempts"), rows("p2_units"), rows("p2_events"),
    admin.query("SELECT body,dataset FROM finnor_os.w1_response_states WHERE tenant_id=$1 AND principal_id=$2 ORDER BY created_at,digest",
      [fixture.tenantId, fixture.principalId]).then(result => result.rows),
    rows("w1_capsules"),
    admin.query("SELECT candidate_digest,body,digest FROM finnor_os.w1_development_checks WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3",
      [fixture.tenantId, fixture.principalId, searchId]).then(result => result.rows),
    rows("w1_stage_observations"),
    admin.query("SELECT body,digest FROM finnor_os.w1_continuation_states WHERE tenant_id=$1 AND principal_id=$2 ORDER BY created_at,digest",
      [fixture.tenantId, fixture.principalId]).then(result => result.rows),
    rows("w1_measurement_gaps"),
    admin.query("SELECT * FROM finnor_os.p2_attempts WHERE tenant_id=$1 AND principal_id=$2 AND body ? 'w1SelectionGroupRef' ORDER BY created_at,id",
      [fixture.tenantId, fixture.principalId]).then(result => result.rows),
    admin.query("SELECT * FROM finnor_os.p2_events WHERE tenant_id=$1 AND principal_id=$2 AND kind IN('W1_NEXT_COMPUTATION_APPLIED','W1_NATIVE_FALLBACK_APPLIED','W1_NATIVE_COMPUTATION_STOPPED') ORDER BY created_at,id",
      [fixture.tenantId, fixture.principalId]).then(result => result.rows),
  ]);
  const jobs = (await admin.query("SELECT id,tenant_id,type,status,claim_fence,protocol_version,payload FROM finnor_os.jobs WHERE id=ANY($1::uuid[])",
    [attempts.map(attempt => attempt.body.jobId)])).rows;
  const usage = (await admin.query("SELECT spent FROM finnor_os.p2_grant_usage WHERE tenant_id=$1 AND principal_id=$2 AND grant_digest=$3 AND resource_id=$4",
    [fixture.tenantId, fixture.principalId, search.request.computeGrant.contentDigest, search.binding.resourceId])).rows[0];
  const activeLeases = (await admin.query("SELECT count(*)::int n FROM finnor_os.compute_resource_leases WHERE tenant_key=$1 AND owner_id=ANY($2::text[]) AND released_at IS NULL AND expires_at>clock_timestamp()",
    [fixture.tenantId, attempts.map(attempt => "p2:" + attempt.delivery_id)])).rows[0].n;
  // The immutable original capsule already owns these exact facets. Preserve
  // the independent oracle's projection without persisting a second authority.
  const nativeDependencySnapshots = capsules.map(row => ({
    capsule_digest: row.digest, body: { facets: row.body.input.dependencyState },
  }));
  const record = { schema: "finnor.w1.native-observations.v1", fixture: fixture.fixture, auth, parent, program, search, episode,
    attempts, units, events, responses, capsules, developmentChecks, jobs, nativeStageObservations, continuationStates,
    measurementGaps, nativeDependencySnapshots, nativeDependencySnapshotSource: "w1_capsules.body.input.dependencyState",
    continuationSourceAttempts, continuationSourceEvents,
    sourceInputs: Object.fromEntries(Object.entries(search.context.input)), grantSpent: Number(usage?.spent ?? 0),
    grantCapacity: search.binding.capacity, activeLeases };
  const path = join(destination, "observations.json");
  await writeFile(path, JSON.stringify(record, null, 2) + "\n");
  const oracle = spawnSync(process.env.FINNOR_TEST_PYTHON ?? "python3",
    [join(import.meta.dirname, "native-oracle.py"), path, "--output", join(destination, "independent-oracle.json")],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
  const outcome = { exitCode: oracle.status, stdout: oracle.stdout, stderr: oracle.stderr, observationsPath: path };
  await writeFile(join(destination, "oracle-process.json"), JSON.stringify(outcome, null, 2) + "\n");
  assert.equal(oracle.status, 0, JSON.stringify(outcome));
  return outcome;
}
