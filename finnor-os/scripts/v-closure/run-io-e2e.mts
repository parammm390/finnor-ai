/** Real filesystem and chunked HTTP boundaries, not business qualification.
 * Failure obligations were registered in the cumulative failure-model.md. */
import { strict as assert } from "node:assert";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { brokerPrivateFile, brokerResponseBytes } from "../../packages/governed-execution/src/broker-io";
import { digest } from "../../packages/governed-execution/src/canonical";
import { interfaceCredential } from "../../packages/private-equity/src/interface-synthesis/bilateral-adapter";

const repo = resolve(import.meta.dirname, "../../..");
const directory = await mkdtemp(join(tmpdir(), "finnor-v-closure-io-"));
const output = join(repo, "scope-v/v1-v5-cumulative-closure/evidence",
  "io-" + new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID().slice(0, 8) + ".json");
const results: Array<{ id: string; status: string; elapsedMs: number; predicate?: string }> = [];
const startedAt = new Date().toISOString();
const expected = (predicate: string) => (error: unknown) => error instanceof Error &&
  (error.message === predicate || (error as NodeJS.ErrnoException).code === predicate);
async function check(id: string, run: () => Promise<void>) {
  const began = performance.now();
  try { await run(); results.push({ id, status: "PASS", elapsedMs: performance.now() - began }); }
  catch (error) {
    results.push({ id, status: "FAIL", elapsedMs: performance.now() - began,
      predicate: error instanceof assert.AssertionError ? "INDEPENDENT_BOUNDARY_ASSERTION_FAILED" : "BOUNDARY_UNAVAILABLE" });
    process.exitCode = 1;
  }
}
const body = Buffer.alloc(8192, 65);
let streamCancelled = false;
const server = createServer((request, response) => {
  response.setHeader("content-type", "application/octet-stream");
  if (request.url === "/small") { response.end(body); return; }
  response.writeHead(200, { "transfer-encoding": "chunked" });
  let sent = 0;
  const timer = setInterval(() => {
    response.write(body); sent++;
    if (sent === 256) { clearInterval(timer); response.end(); }
  }, 1);
  response.on("close", () => { clearInterval(timer); streamCancelled = sent < 256; });
});
try {
  const token = randomBytes(24).toString("hex"), tokenPath = join(directory, "token");
  const profileId = randomUUID(), profileDigest = "a".repeat(64), configPath = join(directory, "configuration");
  await writeFile(tokenPath, token, { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({
    schema: "finnor.bilateral-interface-credentials.v1", credentialDomain: "CANDIDATE_DIRECT_RECORD_READ_ONLY",
    profiles: [{ profileId, profileDigest, tokenPath, tokenDigest: digest(token) }],
  }), { mode: 0o600 });
  const credential = (path: string) => interfaceCredential(path, "CANDIDATE_DIRECT_RECORD_READ_ONLY", profileId, profileDigest);
  await check("production-interface-private-credential", async () => { assert.equal(await credential(configPath), token); });
  const alias = join(directory, "configuration-alias"); await symlink(configPath, alias);
  await check("production-interface-rejects-config-symlink", async () => { await assert.rejects(() => credential(alias), expected("ELOOP")); });
  const tokenAlias = join(directory, "token-alias"); await symlink(tokenPath, tokenAlias);
  const changed = join(directory, "changed-configuration");
  await writeFile(changed, JSON.stringify({
    schema: "finnor.bilateral-interface-credentials.v1", credentialDomain: "CANDIDATE_DIRECT_RECORD_READ_ONLY",
    profiles: [{ profileId, profileDigest, tokenPath: tokenAlias, tokenDigest: digest(token) }],
  }), { mode: 0o600 });
  await check("production-interface-rejects-token-symlink", async () => { await assert.rejects(() => credential(changed), expected("ELOOP")); });
  await check("production-interface-rejects-public-file", async () => {
    await chmod(configPath, 0o644);
    try { await assert.rejects(() => credential(configPath), expected("BROKER_PRIVATE_FILE_UNSAFE")); }
    finally { await chmod(configPath, 0o600); }
  });
  await check("descriptor-rejects-directory", async () => {
    await assert.rejects(() => brokerPrivateFile(directory), expected("BROKER_PRIVATE_FILE_UNSAFE"));
  });
  const fifo = join(directory, "fifo"), created = spawnSync("mkfifo", [fifo], { timeout: 2000 });
  await check("descriptor-rejects-fifo-without-blocking", async () => {
    assert.equal(created.status, 0);
    await assert.rejects(() => brokerPrivateFile(fifo), expected("BROKER_PRIVATE_FILE_UNSAFE"));
  });
  await check("descriptor-rejects-original-size-over-cap", async () => {
    await assert.rejects(() => brokerPrivateFile(tokenPath, undefined, 8), expected("BROKER_PRIVATE_FILE_UNSAFE"));
  });
  await check("descriptor-rejects-wrong-content-witness", async () => {
    await assert.rejects(() => brokerPrivateFile(tokenPath, "0".repeat(64)), expected("BROKER_PRIVATE_FILE_CHANGED"));
  });
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const address = server.address(); assert(address && typeof address !== "string");
  const origin = "http://127.0.0.1:" + address.port;
  await check("actual-http-exact-cap-preserves-bytes", async () => {
    const response = await fetch(origin + "/small", { signal: AbortSignal.timeout(2000) });
    assert.deepEqual(await brokerResponseBytes(response, body.byteLength), body);
  });
  await check("actual-chunked-http-stops-at-byte-cap", async () => {
    const response = await fetch(origin + "/large", { signal: AbortSignal.timeout(2000) });
    assert.equal(response.headers.get("content-length"), null);
    await assert.rejects(() => brokerResponseBytes(response, 262144), expected("BROKER_RESPONSE_BOUND"));
    const until = Date.now() + 1000;
    while (!streamCancelled && Date.now() < until) await new Promise(yes => setTimeout(yes, 5));
    assert.equal(streamCancelled, true, "The real transport must stop before the original source finishes");
  });
} finally {
  server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes()));
  // Only this invocation's newly created synthetic, regenerable files.
  await rm(directory, { recursive: true });
  const sources = await Promise.all([
    "finnor-os/packages/governed-execution/src/broker-io.ts",
    "finnor-os/packages/private-equity/src/interface-synthesis/bilateral-adapter.ts",
    "finnor-os/scripts/v-closure/run-io-e2e.mts",
  ].map(async path => ({ path, sha256: createHash("sha256").update(await readFile(join(repo, path))).digest("hex") })));
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, JSON.stringify({
    schema: "finnor.v-closure.io-e2e.v1", startedAt, finishedAt: new Date().toISOString(),
    rerun: "cd finnor-os && node --import=tsx scripts/v-closure/run-io-e2e.mts",
    inputs: "Fresh synthetic private files, local symlinks/FIFO and unauthenticated loopback chunked HTTP",
    oracle: "Independent OS file type/mode/no-follow behavior, original bytes, real source disconnect before normal completion",
    sources, node: process.version, results, passed: results.length === 10 && results.every(r => r.status === "PASS"),
    limitations: ["Not V1/V2 business qualification", "No differently owned file fixture", "No deterministic in-place mutation race", "No cumulative installed/runtime proof"],
    costUsd: null, credentialsRetained: false,
  }, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ output, passed: results.filter(r => r.status === "PASS").length, total: results.length }));
}
