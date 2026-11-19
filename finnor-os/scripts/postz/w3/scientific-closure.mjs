/** Controlled owning-API counterexample, before any scientific-custody repair.
 * Launch only inside the strict donor-denied disposable-installation supervisor.
 * The injected cache is never a pinned source; original bytes/mode/time return.
 */
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { appendFile, chmod, lstat, mkdir, readFile, realpath, rm, rmdir, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve, isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";

const installation = process.env.W3_CLOSURE_INSTALLATION;
const output = process.env.W3_CLOSURE_OUTPUT;
const descriptorPin = process.env.W3_CLOSURE_DESCRIPTOR_SHA256;
assert(isAbsolute(installation ?? "") && isAbsolute(output ?? ""), "W3_ABSOLUTE_OWNED_CLOSURE_PATHS_REQUIRED");
assert(!resolve(output).startsWith(resolve(installation) + sep), "W3_CLOSURE_OUTPUT_OUTSIDE_PINNED_INSTALLATION");
const parent = dirname(output), parentInfo = await lstat(parent);
assert(parentInfo.isDirectory() && !parentInfo.isSymbolicLink(), "W3_OWNED_CLOSURE_PARENT_REQUIRED");
assert.equal(await realpath(parent), parent);
if (process.platform === "linux") {
  assert.equal(parentInfo.uid, process.getuid(), "W3_CLOSURE_PARENT_OWNER_REQUIRED");
  assert.equal(parentInfo.mode & 0o022, 0, "W3_CLOSURE_PARENT_NOT_GROUP_OR_WORLD_WRITABLE");
}
assert(/^[a-f0-9]{64}$/.test(descriptorPin ?? ""));
assert.equal(resolve(installation), await realpath(installation));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const descriptorBytes = await readFile(join(installation, "finnor-os/w3-development-installation.json"));
assert.equal(sha(descriptorBytes), descriptorPin);
const descriptor = JSON.parse(descriptorBytes);
assert.equal(descriptor.schema, "finnor.w3.development-installation.v1");
assert.equal(descriptor.mode, "DEVELOPMENT_ONLY");
assert.equal(descriptor.productionActive, false);
const manifestBytes = await readFile(join(installation, descriptor.compatibilityManifest.path));
assert.equal(sha(manifestBytes), descriptor.compatibilityManifest.sha256);
const manifest = JSON.parse(manifestBytes);
const require = createRequire(join(installation, "finnor-os/package.json"));
const postgresPackage = await import(pathToFileURL(require.resolve("embedded-postgres")).href);
const EmbeddedPostgres = postgresPackage.default ?? postgresPackage;
const pg = require("pg");
await mkdir(output);
const artifact = async (name, body) => {
  const path = join(output, name);
  assert(path.startsWith(output + "/") && !name.split("/").includes(".."));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(body, null, 2) + "\n", { flag: "wx" });
};
const started = performance.now(), events = [];
const result = {
  schema: "finnor.w3.installed-scientific-unlisted-cache-counterexample.v1",
  startedAt: new Date().toISOString(), descriptorSha256: descriptorPin,
  compatibilityManifestSha256: sha(manifestBytes),
  originalCompiledApiStartupBoundMs: 30000, originalS3FitBoundMs: 20000,
  runtimeBoundary: "ACTUAL_EMITTED_API_AUTHENTICATED_S3_FIT_AND_RELOCATED_INTERPRETER",
  expected: { status: 503, typedCustodyRefusal: true, unlistedCodeExecuted: false },
  fullNativeOrMountedExecuted: false, coldQualification: false,
  productionActive: false, fieldValidated: false, genuineHumanEstablished: false,
  credentialsRecorded: false, productOrOracleOrTimerChanged: false,
};
// Environment parity with the frozen owning native boundary (native.mts):
// the artifact/policy stores live under the probe-owned output directory so
// the actual fit route is configured exactly as in the real installed
// journey.  Setup parity only; no product, predicate or bound changes.
Object.assign(process.env, {
  NODE_ENV: "test", CI: "1", LOG_LEVEL: "error", AUTH_DEV_BYPASS: "0",
  FINNOR_ENVIRONMENT: "staging", FINNOR_P4_PROFILE: "ordinary_disposable",
  FINNOR_W3_PROFILE: "ordinary_disposable", FINNOR_TEST_MANAGED_EXTENSIONS: "omit",
  RATE_LIMIT_PER_MINUTE: "100000", RATE_LIMIT_IP_PER_MINUTE: "100000",
  FINNOR_S3_PYTHON: join(installation, descriptor.entrypoints.s3Python),
  FINNOR_S5_PYTHON: join(installation, descriptor.entrypoints.s5Python),
  FINNOR_S3_MODEL_STORE: join(output, "ordinary-models"),
  FINNOR_S4_POLICY_STORE: join(output, "ordinary-policies"),
  WORKER_JOB_LEASE_SECONDS: "5", FINNOR_STEP_LEASE_SECONDS: "5",
});
delete process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG;
delete process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT;
const port = await new Promise((accept, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(() => accept(port));
  });
});
const adminPassword = randomUUID(), appPassword = randomUUID();
const database = new EmbeddedPostgres({ databaseDir: join(output, "disposable-postgres"),
  user: "w3_admin", password: adminPassword, port, persistent: false, onLog: () => undefined });
const sourceRelative = "finnor-os/scientific/s3/lib/python3.11/site-packages/numpy/__init__.py";
const cacheRelative = "finnor-os/scientific/s3/lib/python3.11/site-packages/numpy/__pycache__/__init__.cpython-311.pyc";
const source = join(installation, sourceRelative), cache = join(installation, cacheRelative);
const cacheDirectory = resolve(cache, ".."), marker = join(output, "unlisted-code-executed.json");
assert(manifest.files.some(file => file.path === sourceRelative));
assert(!manifest.files.some(file => file.path === cacheRelative), "W3_COUNTEREXAMPLE_REQUIRES_UNLISTED_CACHE");
let admin, api, harnessDb, backup, cacheExisted = false, directoryExisted = false, mutationAttempted = false, exitCode = 1;
const timer = setTimeout(() => { console.error("W3_SCIENTIFIC_CLOSURE_TOTAL_BOUND"); process.exit(1) }, 180000);
try {
  await database.initialise();
  await appendFile(join(output, "disposable-postgres/postgresql.conf"), "\ntrack_commit_timestamp=on\n");
  await database.start();
  await database.createDatabase("w3_service");
  const adminUrl = `postgres://w3_admin:${adminPassword}@127.0.0.1:${port}/w3_service`;
  const { migrate } = await import(pathToFileURL(join(installation, descriptor.entrypoints.migrations)).href);
  result.migrations = (await migrate(adminUrl)).length;
  admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD '" + appPassword + "'");
  process.env.DATABASE_URL = adminUrl;
  const owner = randomUUID(), tenant = randomUUID();
  await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'W3 controlled runtime closure')",
    [tenant, randomUUID()]);
  await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",
    [owner, tenant, owner + "@test.invalid"]);
  harnessDb = await import(pathToFileURL(require.resolve("@finnor/db")).href);
  await harnessDb.configureTenantVertical({ tenantId: tenant, verticalKey: "private_equity",
    expectedVersion: 0, createdBy: owner, sourceSystem: "w3:controlled-runtime-closure" });
  process.env.DATABASE_URL = `postgres://finnor_app:${appPassword}@127.0.0.1:${port}/w3_service`;
  const { authenticatedApiFixture } = await import(pathToFileURL(
    join(installation, "finnor-os/scripts/frontier5/x1/authenticated-api-fixture.mts")).href);
  const invoked = performance.now();
  api = await authenticatedApiFixture(installation, owner, entry => {
    if (["X1_COMPILED_API_READY", "X1_COMPILED_API_REFUSAL"].includes(entry.event)) events.push(entry);
  }, { installation });
  const ready = events.filter(entry => entry.event === "X1_COMPILED_API_READY");
  assert.equal(ready.length, 1);
  assert.equal(ready[0].role, "finnor_app");
  assert.equal(ready[0].productionActive, false);
  assert.equal(ready[0].pid, api.compiledPid);
  assert.equal(ready[0].manifestDigest, descriptor.compatibilityManifest.sha256);
  assert(performance.now() - invoked < 30000);
  result.ready = { ...ready[0], fixtureElapsedMs: performance.now() - invoked };
  const generated = spawnSync(process.env.FINNOR_S3_PYTHON, ["-I", "-B", "scripts/s3/reference.py"], {
    cwd: join(installation, "finnor-os"), input: JSON.stringify({ operation: "equivalent" }),
    encoding: "utf8", timeout: 30000, maxBuffer: 8388608 });
  assert.equal(generated.status, 0, "W3_ORIGINAL_REFERENCE_GENERATOR_REQUIRED");
  const { createUpstreamFixtureSupport } = await import(pathToFileURL(
    join(installation, "finnor-os/scripts/s5/owner-fixture.mts")).href);
  let response;
  const native = createUpstreamFixtureSupport({
    admin: () => admin, generatedRows: JSON.parse(generated.stdout).rows,
    begin: new Date(Date.now() - 128 * 86400000).toISOString(), day: 86400000, fixtures: {},
    artifact,
    api: async (_fixture, operation, body) => {
      assert.equal(operation, "fit", "W3_COUNTEREXAMPLE_ONLY_REACHES_ORIGINAL_S3_FIT");
      await artifact("fit-input.json", body);
      const originalSource = await readFile(source);
      assert.equal(sha(originalSource), manifest.files.find(file => file.path === sourceRelative).sha256);
      try {
        const stat = await lstat(cacheDirectory);
        assert(stat.isDirectory() && !stat.isSymbolicLink());
        assert.equal(await realpath(cacheDirectory), cacheDirectory);
        directoryExisted = true;
      } catch (error) { if (error.code !== "ENOENT") throw error }
      try {
        const stat = await lstat(cache);
        assert(stat.isFile() && !stat.isSymbolicLink());
        backup = { bytes: await readFile(cache), mode: stat.mode & 0o7777, atime: stat.atime, mtime: stat.mtime };
        cacheExisted = true;
      } catch (error) { if (error.code !== "ENOENT") throw error }
      const nonce = randomUUID();
      await artifact("fault-input.json", { source: sourceRelative, pinnedSourceSha256: sha(originalSource),
        cache: cacheRelative, cacheWasPresent: cacheExisted, cacheWasPinned: false,
        originalCacheSha256: backup ? sha(backup.bytes) : null, directoryWasPresent: directoryExisted,
        markerPath: marker, nonce, expectedParentPid: api.compiledPid });
      const producerCode = [
        "import importlib.util,json,marshal,os,pathlib,struct,sys",
        "source,cache,marker,nonce=sys.argv[1:]",
        "p=pathlib.Path(source); s=p.stat(); target=pathlib.Path(cache)",
        "payload='import json,os,pathlib,sys\\npathlib.Path('+repr(marker)+').write_text(json.dumps({\"nonce\":'+repr(nonce)+',\"pid\":os.getpid(),\"ppid\":os.getppid(),\"executable\":os.path.realpath(sys.executable)}))\\nraise RuntimeError(\"W3_UNLISTED_SCIENTIFIC_CACHE_EXECUTED\")\\n'",
        "header=importlib.util.MAGIC_NUMBER+struct.pack('<III',0,int(s.st_mtime)&0xffffffff,s.st_size&0xffffffff)",
        "target.parent.mkdir(exist_ok=True)",
        "target.write_bytes(header+marshal.dumps(compile(payload,source,'exec')))",
        "print(json.dumps({'producerPid':os.getpid(),'cacheBytes':target.stat().st_size}))",
      ].join("\n");
      await artifact("cache-producer.json", { code: producerCode, sha256: sha(Buffer.from(producerCode)),
        argv: ["-I", "-B", "-c", "<code>", source, cache, marker, nonce] });
      mutationAttempted = true;
      if (cacheExisted) await chmod(cache, 0o600);
      const producer = spawnSync(process.env.FINNOR_S3_PYTHON,
        ["-I", "-B", "-c", producerCode, source, cache, marker, nonce],
        { cwd: output, encoding: "utf8", timeout: 30000, maxBuffer: 1048576 });
      assert.equal(producer.status, 0, "W3_CONTROLLED_CACHE_PRODUCER_REQUIRED");
      const produced = JSON.parse(producer.stdout);
      assert.equal(sha(await readFile(source)), sha(originalSource));
      assert.equal(await lstat(marker).then(() => true, error => { if (error.code === "ENOENT") return false; throw error }), false);
      result.fault = { ...produced, producerSha256: sha(Buffer.from(producerCode)),
        mutatedCacheSha256: sha(await readFile(cache)), nonce, markerAbsentBeforeRequest: true };
      const began = performance.now();
      const http = await fetch(api.origin + "/api/interventions/fit", { method: "POST",
        headers: { authorization: "Bearer " + api.token, "content-type": "application/json" }, body: JSON.stringify(body) });
      response = { status: http.status, body: await http.json() };
      result.fit = { status: response.status, bodyStatus: response.body.status ?? null, elapsedMs: performance.now() - began };
      await artifact("fit-response.json", response);
      const executed = await readFile(marker).then(bytes => JSON.parse(bytes), error => {
        if (error.code === "ENOENT") return null; throw error;
      });
      if (executed) {
        assert.equal(executed.nonce, nonce);
        assert.equal(executed.ppid, api.compiledPid);
        assert.notEqual(executed.pid, produced.producerPid);
        assert.equal(executed.executable, await realpath(process.env.FINNOR_S3_PYTHON));
      }
      result.observed = { status: response.status, unlistedCodeExecuted: executed !== null,
        actualApiChild: executed, refusalEvents: events.filter(entry => entry.event === "X1_COMPILED_API_REFUSAL") };
      result.preRepairCounterexampleReproduced = response.status === 200 && response.body.status === "FAILED" && executed !== null;
      return response;
    },
  });
  try {
    await native.fixture("w3-scientific-closure-" + randomUUID().slice(0, 8), 1, [],
      { identity: { tenant, principal: owner } });
  } catch (error) {
    if (!response) throw error;
    result.originalFixtureRefusedFailedFit = true;
  }
  assert(response, "W3_ACTUAL_AUTHENTICATED_COMPILED_FIT_REQUIRED");
  assert.equal(response.status, 503, "W3_UNLISTED_SCIENTIFIC_CACHE_MUST_REFUSE_BEFORE_EXECUTION");
  assert.equal(result.observed.unlistedCodeExecuted, false);
  assert(result.observed.refusalEvents.some(entry => /INSTALLATION.*(UNDECLARED|UNLISTED)/.test(entry.predicate)));
  result.status = "PASS_OWNING_COMPILED_SCIENTIFIC_CLOSURE_ONLY"; exitCode = 0;
} catch (error) {
  result.status = "FAILED_RETAINED";
  result.error = error instanceof Error ? error.message : String(error);
} finally {
  try {
    if (mutationAttempted) {
      if (cacheExisted) {
        await chmod(cache, 0o600); await writeFile(cache, backup.bytes);
        await chmod(cache, backup.mode); await utimes(cache, backup.atime, backup.mtime);
        assert.equal(sha(await readFile(cache)), sha(backup.bytes));
        assert.equal((await lstat(cache)).mode & 0o7777, backup.mode);
      } else {
        await rm(cache, { force: true });
        if (!directoryExisted) await rmdir(cacheDirectory);
      }
      result.originalCacheRestored = true;
    }
    if (api) await api.close();
    if (admin) await admin.end();
    if (harnessDb) await harnessDb.getPool().end();
    await database.stop();
  } catch (error) {
    result.status = "FAILED_RETAINED_CLEANUP"; result.cleanupError = String(error); exitCode = 1;
  }
  clearTimeout(timer);
  Object.assign(result, { finishedAt: new Date().toISOString(), elapsedMs: performance.now() - started, exitCode });
  await artifact("result.json", result);
  console.log(JSON.stringify(result));
}
process.exit(exitCode);
