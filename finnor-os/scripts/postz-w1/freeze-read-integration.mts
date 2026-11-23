/** Exact preimages for the single-writer standalone W1 integration, never a protected grant. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../../..");
const directory = resolve(root, "scope-postz/w1-economic-orchestration/integration-proposals/read-v1");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const present = [
  "finnor-os/packages/shared-types/src/index.ts",
  "finnor-os/packages/shared-types/src/operational-queries.ts",
  "finnor-os/packages/db/schema.ts",
  "finnor-os/packages/orchestration/src/fast-read-lane.ts",
  "finnor-os/packages/orchestration/src/operational-query-runtime.ts",
  "finnor-os/packages/orchestration/src/index.ts",
  "finnor-os/packages/orchestration/src/authority-runtime.ts",
  "finnor-os/apps/api/app/api/actions/route.ts",
  "finnor-os/scripts/generate-openapi.ts",
  "finnor-os/packages/private-equity/src/economic-reads/contracts.ts",
  "finnor-os/packages/orchestration/src/economic-read-intake.ts",
  "finnor-os/openapi.json",
  "src/lib/centropy/openapi-types.ts",
  "src/lib/centropy/capability-manifest.generated.json",
];
const absent = [
  "finnor-os/packages/shared-types/src/economic-reads.ts",
  "finnor-os/packages/private-equity/src/economic-reads/operational-query.ts",
  "finnor-os/packages/orchestration/src/economic-query-answer.ts",
  "finnor-os/packages/orchestration/src/economic-read-replay.ts",
  "finnor-os/packages/db/migrations/postz_w1_ordinary_economic_reads.sql",
];
const path = resolve(directory, "preimages.json");
if (process.argv.includes("--check")) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  for (const entry of manifest.preimages) {
    let current: string | null = null;
    try { current = sha256(await readFile(resolve(root, entry.path))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    assert.equal(current, entry.sha256, `PREIMAGE_CHANGED:${entry.path}`);
  }
  process.stdout.write(JSON.stringify({ status: "EXACT_PREIMAGES_MATCH", entries: manifest.preimages.length }) + "\n");
} else {
  await mkdir(directory, { recursive: true });
  const preimages = [];
  for (const path of present) preimages.push({ path, state: "EXACT_BYTES", sha256: sha256(await readFile(resolve(root, path))) });
  for (const path of absent) {
    try { await readFile(resolve(root, path)); throw Error(`NEW_PATH_ALREADY_EXISTS:${path}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    preimages.push({ path, state: "ABSENT", sha256: null });
  }
  const writerIdentity = "scope-postz/w1-economic-orchestration/standalone-integration-identity.json";
  await writeFile(path, JSON.stringify({
    schema: "finnor.postz.w1.read-integration-preimages.v1", frozenAt: new Date().toISOString(),
    writerIdentity, writerIdentitySha256: sha256(await readFile(resolve(root, writerIdentity))),
    baseCommit: "f4c2e41c8a0222c9d83ca1be821b3aef888da08a",
    status: "EXACT_PREIMAGES_FROZEN_NOT_APPLIED", preimages,
    affectedVersions: { queryVersion: "1 additive intents", persistedQueryIntents: "preserve previous predicate plus two reads", jobs: "none new", workerProtocols: "unchanged by read integration" },
    callers: ["Typed QUERY API", "Natural instruction API", "Preclassified canonical core", "Exact duplicate/retry", "Existing tenant dispatcher"],
    oracle: "Original direct-read-contract.md and registered native driver literals; full W001-W060 remain separate",
    qualification: "No W2, S8 protected grant, admission, activation or economic qualification"
  }, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(JSON.stringify({ path, status: "PREIMAGES_FROZEN", entries: preimages.length }) + "\n");
}
