import { readFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("executes the production manifest verifier twice without changing committed source", async () => {
  const backend = fileURLToPath(new URL("../../", import.meta.url));
  const manifests = ["action-manifest.json", "action-manifest.md"];
  const digest = async () => Promise.all(manifests.map(async (name) => ({
    name,
    sha256: createHash("sha256").update(await readFile(new URL(`../../../docs/release/generated/${name}`, import.meta.url))).digest("hex"),
  })));
  const before = await digest();
  const executions = [1, 2].map(() => spawnSync(process.execPath, [
    "--import=" + join(backend, "node_modules/tsx/dist/loader.mjs"),
    "scripts/release/verify-action-manifest.ts",
  ], { cwd: backend, encoding: "utf8", timeout: 60_000 }));
  for (const execution of executions) {
    expect(execution.error).toBeUndefined();
    expect(execution.status).toBe(0);
    expect(execution.stdout).toContain("45/45");
  }
  expect(await digest()).toEqual(before);
  const directory = process.env.FINNOR_PRODUCTION_PREFLIGHT_EVIDENCE_DIR
    ?? await mkdtemp(join(tmpdir(), "finnor-production-manifest-"));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "manifest-readonly.json"), JSON.stringify({
    schema: "finnor.production-manifest-readonly-proof.v1",
    inputs: before,
    steps: executions.map((execution) => ({ command: "tsx scripts/release/verify-action-manifest.ts", exitCode: execution.status, observed: execution.stdout.trim() })),
    observed: { sourceBytesUnchanged: true, repeatedVerification: true },
    rerun: "npm --prefix finnor-os test -- --run tests/integration/production-manifest-readonly.test.ts",
  }, null, 2) + "\n");
});
