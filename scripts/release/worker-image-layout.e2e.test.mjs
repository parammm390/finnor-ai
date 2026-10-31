import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const backend = join(root, "finnor-os")
const workerImportSpecifiers = [...readFileSync(join(backend, "apps/worker/src/index.ts"), "utf8")
  .matchAll(/^\s*import\b(?:[\s\S]*?\bfrom\s*)?["']([^"']+)["'];?/gm)]
  .map((match) => match[1])

test("the actual image layout imports every worker owner and rechecks source custody outside the checkout", () => {
  const dockerfile = readFileSync(join(backend, "Dockerfile.worker"), "utf8")
  const smoke = readFileSync(join(root, "scripts/release/smoke-worker-image.sh"), "utf8")
  assert.match(dockerfile, /^ARG FINNOR_S6_NATIVE_PLATFORM=linux\/arm64$/m)
  assert.match(dockerfile, /^FROM --platform=\$\{FINNOR_S6_NATIVE_PLATFORM\} .* AS s6-native-callee$/m)
  assert.match(dockerfile, /RUN test "\$\(uname -m\)" = aarch64/)
  assert.doesNotMatch(dockerfile, /^FROM --platform=linux\//m)
  const fixture = mkdtempSync(join(tmpdir(), "finnor-worker-image-layout-"))
  const workdir = [...dockerfile.matchAll(/^WORKDIR (\S+)$/gm)].at(-1)?.[1]
  assert.ok(workdir?.startsWith("/app"))
  const deployed = join(fixture, workdir.slice(1))
  mkdirSync(deployed, { recursive: true })
  const copy = (source, destination) => cpSync(source, destination, {
    recursive: true,
    filter: (path) => !relative(source, path).split("/").some((part) => part === "node_modules" || part === "evidence" || part.startsWith(".")),
  })
  const dependencyStage = dockerfile.split("FROM node-runtime AS dependencies")[1].split("\nFROM ")[0]
  for (const instruction of dependencyStage.matchAll(/^COPY (?! --)(.+)$/gm)) {
    const operands = instruction[1].trim().split(/\s+/)
    const destination = operands.pop()
    const target = destination.startsWith("/") ? join(fixture, destination.slice(1)) : resolve(deployed, destination)
    const directory = operands.length > 1 || destination.endsWith("/")
    if (directory) mkdirSync(target, { recursive: true })
    else mkdirSync(dirname(target), { recursive: true })
    for (const source of operands) copy(join(root, source), directory ? join(target, source.split("/").at(-1)) : target)
  }
  // Reuse third-party packages from the host install, but never its workspace
  // links: those point back to another checkout and can make this relocation
  // proof import stale package source instead of the candidate copied above.
  const sharedModules = join(backend, "node_modules")
  const imageModules = join(deployed, "node_modules")
  mkdirSync(imageModules, { recursive: true })
  const workspacePackages = new Map()
  const workspacePatterns = JSON.parse(readFileSync(join(backend, "package.json"), "utf8")).workspaces
  for (const pattern of workspacePatterns) {
    const wildcard = pattern.indexOf("*")
    if (wildcard < 0) continue
    const parent = pattern.slice(0, wildcard).replace(/\/$/, "")
    for (const entry of readdirSync(join(backend, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const relativePath = join(parent, entry.name)
      const manifestPath = join(backend, relativePath, "package.json")
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
      if (manifest.name) workspacePackages.set(manifest.name, join(deployed, relative(backend, join(backend, relativePath))))
    }
  }
  for (const entry of readdirSync(sharedModules, { withFileTypes: true })) {
    const source = join(sharedModules, entry.name)
    const destination = join(imageModules, entry.name)
    if (entry.name === "@finnor") {
      mkdirSync(destination, { recursive: true })
      for (const packageEntry of readdirSync(source, { withFileTypes: true })) {
        const packageName = `@finnor/${packageEntry.name}`
        const workspacePath = workspacePackages.get(packageName) ?? join(source, packageEntry.name)
        symlinkSync(workspacePath, join(destination, packageEntry.name), "dir")
      }
      continue
    }
    symlinkSync(source, destination, statSync(source).isDirectory() ? "dir" : "file")
  }
  for (const [packageName, workspacePath] of workspacePackages) {
    const [scope, name] = packageName.split("/")
    if (!scope?.startsWith("@") || !name) continue
    const scopePath = join(imageModules, scope)
    mkdirSync(scopePath, { recursive: true })
    const destination = join(scopePath, name)
    if (!existsSync(destination)) symlinkSync(workspacePath, destination, "dir")
  }
  const script = `
    const { pathToFileURL } = await import("node:url");
    const projectionResolution = import.meta.resolve("@finnor/projections");
    const expectedProjectionResolution = pathToFileURL(process.cwd() + "/packages/projections/src/index.ts").href;
    if (projectionResolution !== expectedProjectionResolution)
      throw Error("@finnor/projections escaped the relocated candidate: " + projectionResolution);
    if (process.env.FINNOR_WORKER_LAYOUT_TRACE_IMPORTS === "1") {
      const origin = new URL("./apps/worker/src/index.ts", "file://" + process.cwd() + "/");
      for (const specifier of ${JSON.stringify(workerImportSpecifiers)}) {
        const target = specifier.startsWith(".") ? new URL(specifier, origin).href : specifier;
        console.error("WORKER_DEP_START " + specifier);
        await import(target);
        console.error("WORKER_DEP_DONE " + specifier);
      }
    }
    for (const [label, specifier] of [
      ["decision-slice", "./packages/private-equity/src/decision-slice/service.ts"],
      ["evidence-store", "./packages/private-equity/src/evidence-execution/store.ts"],
      ["counterexample-search", "./packages/private-equity/src/counterexample-search/service.ts"],
      ["worker-index", "./apps/worker/src/index.ts"],
    ]) {
      console.error("IMPORT_START " + label);
      await import(specifier);
      console.error("IMPORT_DONE " + label);
    }
    const decision = await import("./packages/private-equity/src/decision-slice/service.ts");
    const worker = await import("./apps/worker/src/index.ts");
    const evidence = await import("./packages/private-equity/src/evidence-execution/store.ts");
    const challenge = await import("./packages/private-equity/src/counterexample-search/service.ts");
    if (typeof decision.compileDecisionSlice !== "function" || typeof worker.createWorker !== "function")
      throw Error("worker owners were not imported");
    const p4 = await evidence.codeIdentity();
    const m4 = await challenge.codeIdentity();
    if (!p4.files.some(f => f.path === "package-lock.json") || !m4.files.length)
      throw Error("source custody omitted canonical inputs");
    console.log(JSON.stringify({workerImported:true,p4Sources:p4.files.length,m4Sources:m4.files.length,projectionResolution}));
  `
  let result, installedOwnerCommitWired = false
  const prebuild = []
  try {
    const build = JSON.parse(readFileSync(join(deployed, "apps/api/package.json"), "utf8")).scripts.build
    const stages = build.split(/\s*&&\s*/)
    assert.equal(stages.pop(), "next build", "review changed API build stages before relying on this source-custody proof")
    const manifestPath = join(deployed, "packages/orchestration/src/capabilities/planner-replay-manifest.json")
    const pinned = JSON.parse(readFileSync(manifestPath, "utf8"))
    const before = new Map(pinned.sources.map(source => [source.file, createHash("sha256").update(readFileSync(join(deployed, source.file))).digest("hex")]))
    for (const stage of stages) {
      assert.match(stage, /^tsx [^ ]+$/)
      const observed = spawnSync(process.execPath, ["--import=tsx", resolve(deployed, "apps/api", stage.slice(4))], {
        cwd: join(deployed, "apps/api"), encoding: "utf8", timeout: 30_000,
        env: { PATH: dirname(process.execPath), NODE_ENV: "test", TSX_TSCONFIG_PATH: join(deployed, "tsconfig.json") },
      })
      prebuild.push({ command: stage, exitCode: observed.status, stdout: observed.stdout, stderr: observed.stderr })
      assert.equal(observed.status, 0, JSON.stringify(prebuild))
    }
    const check = spawnSync(process.execPath, ["--import=tsx", "scripts/release/generate-planner-replay-manifest.mts", "--check"], {
      cwd: deployed, encoding: "utf8", timeout: 30_000,
      env: { PATH: dirname(process.execPath), NODE_ENV: "test", TSX_TSCONFIG_PATH: join(deployed, "tsconfig.json") },
    })
    prebuild.push({ command: "planner manifest check after API source stamping", exitCode: check.status, stdout: check.stdout, stderr: check.stderr })
    const changedPinnedSources = [...before].flatMap(([file, digest]) => {
      const actual = createHash("sha256").update(readFileSync(join(deployed, file))).digest("hex")
      return actual === digest ? [] : [{ file, beforeSha256: digest, afterSha256: actual }]
    })
    assert.equal(check.status, 0, JSON.stringify({ prebuild, changedPinnedSources }))
    for (const [file, digest] of before) assert.equal(createHash("sha256").update(readFileSync(join(deployed, file))).digest("hex"), digest, `API prebuild changed pinned source: ${file}`)

    result = spawnSync(process.execPath, [
      "--import=" + join(backend, "node_modules/tsx/dist/loader.mjs"),
      "--input-type=module", "-e", script,
    ], {
      cwd: deployed,
      env: { ...process.env, TSX_TSCONFIG_PATH: join(deployed, "tsconfig.json"), NODE_ENV: "test" },
      encoding: "utf8", timeout: Number(process.env.FINNOR_WORKER_LAYOUT_TIMEOUT_MS) || 60_000, maxBuffer: 2 * 1024 * 1024,
    })
    assert.equal(result.status, 0, JSON.stringify({
      status: result.status,
      signal: result.signal,
      error: result.error ? { name: result.error.name, message: result.error.message, code: result.error.code, errno: result.error.errno, syscall: result.error.syscall } : null,
      stdout: result.stdout,
      stderr: result.stderr,
    }, null, 2))
    const observed = JSON.parse(result.stdout.trim().split("\n").at(-1))
    assert.equal(observed.workerImported, true)
    assert.ok(observed.p4Sources > 20 && observed.m4Sources > 20)
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")
    const production = readFileSync(join(root, ".github/workflows/production-release.yml"), "utf8")
    assert.match(ci, /^  worker-image:\n/m)
    for (const workflow of [ci, production]) {
      assert.match(workflow, /run: bash scripts\/release\/smoke-worker-image\.sh/)
    }
    const ownerAt = smoke.indexOf('"$image" node --import=tsx scripts/r3/run-owner-e2e.mts')
    assert.ok(ownerAt > 0)
    const ownerCommand = smoke.slice(smoke.lastIndexOf("if docker run", ownerAt), ownerAt)
    assert.match(ownerCommand, /--env FINNOR_R3_INSTALLED_SOURCE_COMMIT="\$FINNOR_COMMIT_SHA"/,
      "installed R3 restart must receive the exact image commit instead of requiring Git")
    installedOwnerCommitWired = true
  } finally {
    const directory = process.env.FINNOR_WORKER_LAYOUT_EVIDENCE_DIR
      ?? mkdtempSync(join(tmpdir(), "finnor-worker-image-layout-proof-"))
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "worker-image-layout.json"), JSON.stringify({
      schema: "finnor.worker-image-layout-proof.v1",
      inputs: { workdir, dockerfileSha256: createHash("sha256").update(dockerfile).digest("hex"), smokeSha256: createHash("sha256").update(smoke).digest("hex") },
      steps: ["Copy production source into image WORKDIR outside checkout", "Reuse host third-party dependencies while mapping workspace packages to relocated candidate source", "Execute the actual API prebuild source stamps and check pinned planner sources remain unchanged", "Import actual worker owners", "Recheck P4/M4 canonical source identities"],
      observed: {
        installedOwnerCommitWired,
        prebuild,
        exitCode: result?.status,
        signal: result?.signal,
        error: result?.error ? { name: result.error.name, message: result.error.message, code: result.error.code, errno: result.error.errno, syscall: result.error.syscall } : null,
        stdout: result?.stdout,
        stderr: result?.stderr,
      },
      rerun: "node --test scripts/release/worker-image-layout.e2e.test.mjs",
      actualLinuxImageProof: false,
    }, null, 2) + "\n")
    rmSync(fixture, { recursive: true, force: true })
  }
})

test("runtime manifest check executes with Node and no build tools on PATH", () => {
  const dockerfile = readFileSync(join(backend, "Dockerfile.worker"), "utf8")
  const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM ") + 1)
  const instruction = runtime.split("\n").find(line => line.startsWith("RUN ") && /capabilities:planner-manifest|generate-planner-replay-manifest/.test(line))
  assert.ok(instruction, "the final image must check the planner source manifest")
  const command = instruction.slice(4)
  const fixture = mkdtempSync(join(tmpdir(), "finnor-worker-node-only-"))
  const directory = process.env.FINNOR_WORKER_LAYOUT_EVIDENCE_DIR
    ?? mkdtempSync(join(tmpdir(), "finnor-worker-runtime-command-proof-"))
  mkdirSync(directory, { recursive: true })
  const node = join(fixture, "node")
  symlinkSync(process.execPath, node)
  let result
  try {
    result = spawnSync("/bin/sh", ["-c", command], {
      cwd: backend, env: { PATH: fixture, NODE_ENV: "test", TSX_TSCONFIG_PATH: join(backend, "tsconfig.json") },
      encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
    })
    assert.equal(result.status, 0, JSON.stringify({ command, status: result.status, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }))
  } finally {
    writeFileSync(join(directory, "runtime-command.json"), JSON.stringify({
      schema: "finnor.worker-runtime-command-proof.v1",
      inputs: { command, pathContainsOnlyNode: true, dockerfileSha256: createHash("sha256").update(dockerfile).digest("hex") },
      steps: ["Read the actual image manifest-check instruction", "Execute it with only Node on PATH"],
      observed: { exitCode: result?.status, signal: result?.signal, stdout: result?.stdout, stderr: result?.stderr, error: result?.error?.message },
      rerun: "node --test --test-name-pattern='runtime manifest check' scripts/release/worker-image-layout.e2e.test.mjs",
      actualLinuxImageProof: false,
    }, null, 2) + "\n")
    rmSync(fixture, { recursive: true, force: true })
  }
})
