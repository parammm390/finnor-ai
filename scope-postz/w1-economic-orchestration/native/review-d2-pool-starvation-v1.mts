/** Failure-first D2 driver (remaining-roots-failure-contract-v1.md).
 * Real disposable embedded PostgreSQL (migrated), real singleton pool forced
 * to its field profile max:1 via a non-"localhost"/"127.0.0.1" loopback
 * spelling (LOCALHOST), real policy fixture copied from the CONTROL
 * 0004-repaired s4-store. Holds the pool's only connection in an open
 * transaction (the nativeControlSnapshotTx shape) and calls the REAL
 * recheckSearchOwners with the scoped client.
 * Defect signature D2_SNAPSHOT_POOL_STARVATION: the policy recheck performs
 * an unscoped pool acquisition, which blocks on the held connection and
 * fails with the pool connect timeout (~5s), proving the deadlock shape.
 * Repaired: no second pool acquisition; the policy read runs on the scoped
 * client and fails fast with the expected semantic unavailability (no belief
 * rows in the fresh disposable database). */
import { strict as assert } from "node:assert";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { ownDisposablePostgres, closeDisposablePostgres } from "../../../finnor-os/scripts/postz-w1/disposable-postgres.mjs";

const destination = process.argv[2] ?? "";
assert(isAbsolute(destination) && !existsSync(destination), "NEW_ABSOLUTE_REGRESSION_RECEIPT_REQUIRED");
const root = resolve(import.meta.dirname, "../../..");
const evidencePolicy = join(root, "scope-postz/w1-economic-orchestration/evidence/control-recovery-0004-repaired/execution/s4-store/b9e6017a-ad7d-4bd8-8f0e-3e006ead561a/b63b71a1-e127-41ab-bfdd-ebc9b368ced6/policies/94e7b679dc8f2f2968bd3c93d051fb87fecd2dfcdbcd1234a752e5e7d0a3e525.json");
const policy = JSON.parse(readFileSync(evidencePolicy, "utf8"));
const tenantId = policy.tenantId as string, principal = policy.principalId as string;

const port = await new Promise<number>((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const scratch = mkdtempSync(join(tmpdir(), "finnor-w1-d2-"));
const owned = ownDisposablePostgres(scratch, join(scratch, "db"), destination + ".cleanup.json");
try {
const store = join(scratch, "s4-store");
const policyDir = join(store, tenantId, principal, "policies");
mkdirSync(policyDir, { recursive: true });
copyFileSync(evidencePolicy, join(policyDir, `${policy.ref.contentDigest}.json`));
chmodSync(store, 0o700); chmodSync(join(store, tenantId), 0o700); chmodSync(join(store, tenantId, principal), 0o700); chmodSync(policyDir, 0o700);

const requireFinnor = createRequire(join(root, "finnor-os/package.json"));
const embeddedModule = requireFinnor("embedded-postgres");
const EmbeddedPostgres = embeddedModule.default ?? embeddedModule;
const database = owned.attach(new EmbeddedPostgres({ databaseDir: join(scratch, "db"), user: "finnor", password: "finnor", port,
  persistent: true, postgresFlags: ["-c", "listen_addresses=127.0.0.1"], onLog: () => undefined, onError: () => undefined }));
await database.initialise(); await database.start();
await database.createDatabase("w1_d2");
process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
const { migrate } = await import("../../../finnor-os/packages/db/migrate");
await migrate(`postgres://finnor:finnor@127.0.0.1:${port}/w1_d2`);

// Field profile: a loopback URL that is neither "localhost" nor "127.0.0.1"
// selects the pooled max:1 configuration, exactly as a non-localhost
// disposable deployment URL does.
process.env.DATABASE_URL = `postgres://finnor:finnor@LOCALHOST:${port}/w1_d2?sslmode=disable`;
process.env.FINNOR_S4_POLICY_STORE = store;
const { getPool } = await import("../../../finnor-os/packages/db/index");
const { readEnterpriseContingentPolicy } = await import("../../../finnor-os/packages/private-equity/src/enterprise-control");

const pool = getPool();
let connectAttempts = 0;
pool.connect = new Proxy(pool.connect, {
  apply(target, receiver, args) {
    connectAttempts += 1;
    return Reflect.apply(target, receiver, args);
  },
});

const ctx = { auth: { tenantId, userId: principal, role: "owner" } } as never;
const held = await pool.connect();
await held.query("BEGIN");
// Case A: the snapshot-transaction shape — the pool's only connection is held
// by an open transaction and the policy read receives it as the scoped client
// (the third parameter only exists after the repair; before it, the read is
// unscoped and must wait out the 5s pool connect timeout).
const attemptsBeforeA = connectAttempts;
const startedAt = performance.now();
let rejection = "";
try {
  await readEnterpriseContingentPolicy(ctx, policy.ref, held as never);
} catch (error) {
  rejection = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
const elapsedMs = Math.round(performance.now() - startedAt);
const caseAAttempts = connectAttempts - attemptsBeforeA;
await held.query("ROLLBACK"); held.release();

// Case B (control): the same read with the pool free returns the same
// semantic miss immediately, proving case A's delay is pool starvation, not
// the fixture.
const attemptsBeforeB = connectAttempts;
const startedB = performance.now();
let rejectionB = "";
try {
  await readEnterpriseContingentPolicy(ctx, policy.ref);
} catch (error) {
  rejectionB = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
const elapsedBMs = Math.round(performance.now() - startedB);
const caseBAttempts = connectAttempts - attemptsBeforeB;

const starved = caseAAttempts >= 1 && elapsedMs >= 4000 && elapsedBMs < 3000 && rejection === rejectionB;
const threaded = caseAAttempts === 0 && elapsedMs < 4000 && rejection === rejectionB;
const receipt = {
  schema: "finnor.w1.d2-pool-starvation.v1",
  poolMax: (pool as unknown as { options: { max: number } }).options.max,
  caseA: { connectAttempts: caseAAttempts, elapsedMs, rejection },
  caseBControl: { connectAttempts: caseBAttempts, elapsedMs: elapsedBMs, rejection: rejectionB },
  observed: starved ? "D2_SNAPSHOT_POOL_STARVATION" : threaded ? "D2_SCOPED_CLIENT_THREADED" : "UNEXPECTED",
  defect: starved,
};
writeFileSync(destination, JSON.stringify(receipt, null, 1) + "\n");
console.log(JSON.stringify(receipt));
process.exitCode = starved ? 1 : threaded ? 0 : 2;
} finally {
  await closeDisposablePostgres(owned, [async () => (await import("../../../finnor-os/packages/db/index")).closePool()]);
}
