/** Runtime availability only; no owner, browser, admission or economic gate. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createRequire } from "node:module";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

const repo = resolve(import.meta.dirname, "../../..");
const name = process.argv[2];
assert.ok(name && basename(name) === name && /^[a-z0-9-]+\.json$/.test(name));
const evidence = join(repo, "scope-pm/phase-05-m3-capital-program/scope-evidence", name);
assert.ok(!existsSync(evidence), "Evidence already exists");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ["PATH", "HOME", "TMPDIR"].includes(key)));
const receipt: any = {
  schema: "finnor.m3.runtime-closure.v1", startedAt: new Date().toISOString(),
  qualification: "CHECKOUT_LOCAL_RUNTIME_AVAILABILITY_ONLY", checks: [], identities: [],
  costs: { money: null, externalProviderCalls: 0, status: "LOCAL_COST_UNMETERED" },
  rerun: `cd ${join(repo, "finnor-os")} && node --import=tsx scripts/m3/check-runtime.mts <new-receipt-name.json>`,
};
const directory = await mkdtemp(join(tmpdir(), "finnor-m3-runtime-"));
let postgres: EmbeddedPostgres | undefined;
let client: pg.Client | undefined;
let port: number | undefined;
let stopped = false;
try {
  for (const path of ["package-lock.json", "finnor-os/package-lock.json",
    "finnor-os/scripts/m3/check-runtime.mts",
    "finnor-os/packages/epistemic-runtime/src/intervention-requirements.txt",
    "finnor-os/packages/epistemic-runtime/src/requirements-s5.txt",
    "finnor-os/packages/private-equity/src/evidence-execution/vision-ocr.m",
    "node_modules/next/package.json", "finnor-os/node_modules/next/package.json",
    "finnor-os/node_modules/fs-ext/package.json",
    "finnor-os/node_modules/embedded-postgres/package.json",
    "finnor-os/node_modules/@embedded-postgres/darwin-arm64/package.json",
    "finnor-os/node_modules/@embedded-postgres/darwin-arm64/native/bin/postgres",
    "finnor-os/node_modules/@embedded-postgres/darwin-arm64/native/bin/initdb",
    "finnor-os/node_modules/@embedded-postgres/darwin-arm64/native/bin/pg_ctl"]) {
    const bytes = await readFile(join(repo, path));
    if (path.endsWith("package-lock.json")) {
      const committed = execFileSync("git", ["-C", repo, "show", `HEAD:${path}`]);
      assert.equal(sha(bytes), sha(committed), "Tracked lockfile changed");
    }
    receipt.identities.push({ path, sha256: sha(bytes),
      ...(path.endsWith("/package.json") ? { version: JSON.parse(bytes.toString()).version } : {}) });
  }
  receipt.identities.push({ path: await realpath(process.execPath),
    sha256: sha(await readFile(process.execPath)), version: process.version });
  const require = createRequire(import.meta.url);
  const native = require("fs-ext") as { flockSync(fd: number, mode: string): void };
  const lock = join(directory, "lock");
  const first = openSync(lock, "wx", 0o600), second = openSync(lock, "r+");
  try {
    native.flockSync(first, "exnb");
    assert.throws(() => native.flockSync(second, "exnb"),
      (error: any) => ["EAGAIN", "EWOULDBLOCK"].includes(error.code));
    native.flockSync(first, "un");
    native.flockSync(second, "exnb");
    native.flockSync(second, "un");
  } finally { closeSync(first); closeSync(second); }
  const binding = join(repo, "finnor-os/node_modules/fs-ext/build/Release/fs_ext.node");
  receipt.identities.push({ path: binding, sha256: sha(await readFile(binding)) });
  receipt.checks.push({ id: "native-lock-contention", status: "PASS" });
  for (const [path, code] of [
    [".m1-python/bin/python3.11", "import sys,importlib.metadata as m; assert sys.version.startswith('3.11.'); pins={'numpy':'2.3.3','scipy':'1.16.2','statsmodels':'0.14.5','arch':'8.0.0','pandas':'2.3.2'}; versions={k:m.version(k) for k in pins}; assert versions==pins; import statsmodels.api,arch; import json; print(json.dumps({'python':sys.version.split()[0],'versions':versions}))"],
    [".m1-s5-python/bin/python", "import sys,numpy,scipy,json; from scipy.optimize._highspy._core import HIGHS_VERSION_MAJOR,HIGHS_VERSION_MINOR,HIGHS_VERSION_PATCH; h=f'{HIGHS_VERSION_MAJOR}.{HIGHS_VERSION_MINOR}.{HIGHS_VERSION_PATCH}'; assert sys.version.startswith('3.12.') and numpy.__version__=='2.3.3' and scipy.__version__=='1.16.2' and h=='1.8.0'; print(json.dumps({'python':sys.version.split()[0],'numpy':numpy.__version__,'scipy':scipy.__version__,'highs':h}))"],
  ]) {
    const executable = join(repo, path!);
    receipt.checks.push({ id: path, status: "PASS", observed: JSON.parse(execFileSync(executable,
      ["-c", code!], { env: environment, timeout: 180000, encoding: "utf8" })) });
    receipt.identities.push({ path: executable, resolved: await realpath(executable),
      sha256: sha(await readFile(executable)) });
  }
  // Generated PNG has no text; exercising Vision is not a recognition-accuracy claim.
  const image = execFileSync("python3", ["-c",
    "import sys,zlib,struct; c=lambda t,b:struct.pack('!I',len(b))+t+b+struct.pack('!I',zlib.crc32(t+b)&0xffffffff); sys.stdout.buffer.write(b'\\x89PNG\\r\\n\\x1a\\n'+c(b'IHDR',struct.pack('!2I5B',64,64,8,2,0,0,0))+c(b'IDAT',zlib.compress((b'\\x00'+b'\\xff\\xff\\xff'*64)*64))+c(b'IEND',b''))"],
    { env: environment });
  const ocr = join(repo, ".p4-runtime/vision-ocr");
  const recognized = JSON.parse(execFileSync(ocr, [], {
    input: image, env: environment, timeout: 25000, encoding: "utf8" }));
  assert.equal(recognized.width, 64); assert.equal(recognized.height, 64);
  assert.ok(Array.isArray(recognized.lines));
  receipt.checks.push({ id: "local-apple-vision", status: "PASS", observed: recognized,
    inputSha256: sha(image) });
  receipt.identities.push({ path: ocr, sha256: sha(await readFile(ocr)) });
  port = await new Promise<number>((yes, no) => {
    const server = createServer(); server.once("error", no);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      server.close(() => yes(address.port));
    });
  });
  assert.notEqual(port, 5432);
  postgres = new EmbeddedPostgres({ databaseDir: join(directory, "db"),
    user: "m3_runtime", password: randomUUID(), port, persistent: false,
    postgresFlags: ["-h", "127.0.0.1"], onLog: () => undefined, onError: () => undefined });
  await postgres.initialise(); await postgres.start();
  client = postgres.getPgClient("postgres", "127.0.0.1");
  await client.connect();
  const observed = (await client.query("SELECT 1 AS probe, version() AS version")).rows[0];
  assert.equal(observed.probe, 1);
  await client.end(); client = undefined;
  await postgres.stop(); stopped = true;
  await new Promise<void>((yes, no) => {
    const socket = createConnection({ host: "127.0.0.1", port: port! });
    socket.setTimeout(2000);
    socket.once("connect", () => { socket.destroy(); no(Error("Disposable listener survived stop")); });
    socket.once("timeout", () => { socket.destroy(); no(Error("Stop verification timed out")); });
    socket.once("error", (error: any) => error.code === "ECONNREFUSED" ? yes() : no(error));
  });
  receipt.checks.push({ id: "disposable-postgresql-start-query-stop", status: "PASS",
    host: "127.0.0.1", port, observed, listenerAfterStop: "ECONNREFUSED" });
  receipt.status = "PASS";
} catch (error) {
  receipt.status = "FAIL";
  receipt.failure = error instanceof Error ? { message: error.message } : String(error);
  process.exitCode = 1;
} finally {
  await client?.end();
  if (postgres && !stopped) { await postgres.stop(); stopped = true; }
  await rm(directory, { recursive: true, force: true });
  receipt.cleanup = { ownedTemporaryDirectoryRemoved: true, postgresStopped: stopped };
  receipt.finishedAt = new Date().toISOString();
  await mkdir(resolve(evidence, ".."), { recursive: true });
  await writeFile(evidence, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: receipt.status, evidence }));
}
// embedded-postgres's beforeExit hook otherwise replaces a nonzero exitCode.
process.exit(receipt.status === "PASS" ? 0 : 1);
