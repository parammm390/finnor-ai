import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const backend = join(root, "finnor-os")

test("the actual image layout imports every worker owner and rechecks source custody outside the checkout", () => {
  const fixture = mkdtempSync(join(tmpdir(), "finnor-worker-image-layout-"))
  const dockerfile = readFileSync(join(backend, "Dockerfile.worker"), "utf8")
  const workdir = [...dockerfile.matchAll(/^WORKDIR (\S+)$/gm)].at(-1)?.[1]
  assert.ok(workdir?.startsWith("/app"))
  const deployed = join(fixture, workdir.slice(1))
  mkdirSync(deployed, { recursive: true })
  const copy = (source, destination) => cpSync(source, destination, {
    recursive: true,
    filter: (path) => !relative(source, path).split("/").some((part) => part === "node_modules" || part === "evidence" || part.startsWith(".")),
  })
  for (const name of ["packages", "apps", "scripts"]) copy(join(backend, name), join(deployed, name))
  for (const name of ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.base.json"]) {
    cpSync(join(backend, name), join(deployed, name))
  }
  if (/COPY package-lock\.json \/app\/package-lock\.json/.test(dockerfile)) {
    cpSync(join(root, "package-lock.json"), join(fixture, "app/package-lock.json"))
  }
  if (/COPY infra\/deployment\/production\.contract\.json \/app\/infra\/deployment\//.test(dockerfile)) {
    mkdirSync(join(fixture, "app/infra/deployment"), { recursive: true })
    cpSync(join(root, "infra/deployment/production.contract.json"), join(fixture, "app/infra/deployment/production.contract.json"))
  }
  symlinkSync(join(backend, "node_modules"), join(deployed, "node_modules"), "dir")
  const script = `
    const decision = await import("./packages/private-equity/src/decision-slice/service.ts");
    const evidence = await import("./packages/private-equity/src/evidence-execution/store.ts");
    const challenge = await import("./packages/private-equity/src/counterexample-search/service.ts");
    const worker = await import("./apps/worker/src/index.ts");
    if (typeof decision.compileDecisionSlice !== "function" || typeof worker.createWorker !== "function")
      throw Error("worker owners were not imported");
    const p4 = await evidence.codeIdentity();
    const m4 = await challenge.codeIdentity();
    if (!p4.files.some(f => f.path === "package-lock.json") || !m4.files.length)
      throw Error("source custody omitted canonical inputs");
    console.log(JSON.stringify({workerImported:true,p4Sources:p4.files.length,m4Sources:m4.files.length}));
  `
  let result
  try {
    result = spawnSync(process.execPath, [
      "--import=" + join(backend, "node_modules/tsx/dist/loader.mjs"),
      "--input-type=module", "-e", script,
    ], {
      cwd: deployed,
      env: { ...process.env, TSX_TSCONFIG_PATH: join(deployed, "tsconfig.json"), NODE_ENV: "test" },
      encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
    })
    assert.equal(result.status, 0, result.stderr)
    const observed = JSON.parse(result.stdout.trim().split("\n").at(-1))
    assert.equal(observed.workerImported, true)
    assert.ok(observed.p4Sources > 20 && observed.m4Sources > 20)
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")
    const production = readFileSync(join(root, ".github/workflows/production-release.yml"), "utf8")
    assert.match(ci, /^  worker-image:\n/m)
    for (const workflow of [ci, production]) {
      assert.match(workflow, /run: bash scripts\/release\/smoke-worker-image\.sh/)
    }
  } finally {
    const directory = process.env.FINNOR_WORKER_LAYOUT_EVIDENCE_DIR
      ?? mkdtempSync(join(tmpdir(), "finnor-worker-image-layout-proof-"))
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "worker-image-layout.json"), JSON.stringify({
      schema: "finnor.worker-image-layout-proof.v1",
      inputs: { workdir, dockerfileSha256: createHash("sha256").update(dockerfile).digest("hex") },
      steps: ["Copy production source into image WORKDIR outside checkout", "Reuse owned host dependency graph", "Import actual worker owners", "Recheck P4/M4 canonical source identities"],
      observed: { exitCode: result?.status, stdout: result?.stdout, stderr: result?.stderr },
      rerun: "node --test scripts/release/worker-image-layout.e2e.test.mjs",
      actualLinuxImageProof: false,
    }, null, 2) + "\n")
    rmSync(fixture, { recursive: true, force: true })
  }
})
