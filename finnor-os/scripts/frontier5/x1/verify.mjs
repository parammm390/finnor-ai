import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const os = join(repo, "finnor-os");
const scope = join(repo, "scope-frontier5/x1-institutional-programme-compiler");
const manifest = JSON.parse(readFileSync(join(scope, "verification-plan.json"), "utf8"));
const profile = JSON.parse(readFileSync(join(scope, "profile.json"), "utf8"));
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? null : args[at + 1] ?? null;
};
const stage = option("--stage");
const only = option("--check");
const named = manifest.stages.find((entry) => entry.id === stage);
if (!named || args.some((arg, i) => arg.startsWith("--") && !["--stage", "--check", "--evidence"].includes(arg))
    || (only && !["typecheck", "lint"].includes(only))) {
  console.error("Use --stage <frozen-stage> [--check typecheck|lint] [--evidence <fresh-private-directory>]");
  process.exit(2);
}
const root = manifest.privateEvidenceRoot;
mkdirSync(root, { recursive: true, mode: 0o700 });
const privateRoot = realpathSync(root);
const destination = resolve(option("--evidence") ?? join(privateRoot, `verify-${stage}-${Date.now()}-${randomUUID()}`));
if (!destination.startsWith(privateRoot + sep) || existsSync(destination) || realpathSync(dirname(destination)) !== privateRoot) {
  console.error("Evidence must be a new direct child of the registered private evidence root");
  process.exit(2);
}
mkdirSync(destination, { mode: 0o700 });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pin = (path) => ({ path: relative(repo, path), sha256: sha(readFileSync(path)) });
const git = (...command) => {
  const result = spawnSync("git", ["-C", repo, ...command], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Git read failed: ${command.join(" ")}`);
  return result.stdout.trim();
};
const changed = git("status", "--porcelain=v1", "-uall").split("\n").filter(Boolean).map((line) => line.slice(3));
const sourcePins = changed.filter((path) => existsSync(join(repo, path))).map((path) => pin(join(repo, path)));
for (const path of [
  "finnor-os/packages/private-equity/src/institution-program/contracts.ts",
  "finnor-os/packages/private-equity/src/institution-program/checker.ts",
  "finnor-os/packages/private-equity/src/institution-program/checker-raw.ts",
  "finnor-os/packages/private-equity/src/institution-program/source-decoder.ts",
  "finnor-os/packages/private-equity/src/institution-program/reconstruction.ts",
  "finnor-os/packages/private-equity/src/institution-program/owner-admission.ts",
  "finnor-os/packages/private-equity/package.json",
  "finnor-os/package-lock.json",
  "finnor-os/scripts/frontier5/x1/verify.mjs",
  "finnor-os/scripts/frontier5/x1/eslint.config.mjs",
  "finnor-os/scripts/frontier5/x1/tsconfig.oracle.json",
  "finnor-os/scripts/frontier5/x1/kernel.mts",
  "finnor-os/scripts/frontier5/x1/protocol-cases.mts",
  "finnor-os/scripts/frontier5/x1/reconstruction-cases.mts",
  "finnor-os/scripts/frontier5/x1/reference/original-input.json",
  "finnor-os/scripts/frontier5/x1/reference/expected-ledger.json",
  "finnor-os/scripts/frontier5/x1/reference/challenges.json",
  "finnor-os/scripts/frontier5/x1/reference/base-candidate.json",
]) if (!sourcePins.some((entry) => entry.path === path)) sourcePins.push(pin(join(repo, path)));
const free = (() => { const fs = statfsSync(repo, { bigint: true }); return fs.bavail * fs.bsize; })();
const record = {
  schema: "finnor.frontier5.x1.offline-evidence.v1", stage, check: only,
  startedAt: new Date().toISOString(), status: "NOT_RUN", source: {
    commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"),
    dirty: sourcePins, userInstructionFileUnstaged: changed.includes("AGENTS.md"),
  },
  runtime: { node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch,
    lock: pin(join(os, "package-lock.json")), profile: pin(join(scope, "profile.json")),
    oracle: pin(join(scope, "oracle-contract.md")), failureModel: pin(join(scope, "failure-model.md")),
    verificationPlan: pin(join(scope, "verification-plan.json")) },
  inputs: ["reference/original-input.json", "reference/base-candidate.json", "reference/expected-ledger.json",
    "reference/challenges.json"].map((path) => pin(join(os, "scripts/frontier5/x1", path))),
  originalFailure: "oracle-precode-3697f0c2/missing-interface.log",
  capacity: { freeBytes: free.toString(), liveMinimumFreeBytes: String(manifest.limits.liveMinimumFreeBytes),
    finalBuildMinimumFreeBytes: String(manifest.limits.finalBuildMinimumFreeBytes) },
  limits: { wallSeconds: manifest.limits.smallCheckWallSeconds, kernelHeapMiB: manifest.limits.kernelNodeHeapMiB,
    smallHeapMiB: manifest.limits.smallCheckNodeHeapMiB, outputBytes: manifest.limits.smallCheckOutputBytes },
  commands: [], pending: manifest.stages.filter((entry) => entry.live).map((entry) => entry.id),
  authority: "development-only; no protected custody or owner/effect admission",
};
const save = () => writeFileSync(join(destination, "run.json"), JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const finish = (status, exit, reason) => {
  record.status = status; record.endedAt = new Date().toISOString(); record.reason = reason;
  record.rerun = `node finnor-os/scripts/frontier5/x1/verify.mjs --stage ${stage}${only ? ` --check ${only}` : ""} --evidence <new-private-directory>`;
  save();
  console.log(JSON.stringify({ status, stage, reason, evidence: destination, commands: record.commands.map(({ label, exitCode }) => ({ label, exitCode })) }));
  process.exit(exit);
};
if (free < BigInt(manifest.limits.smallCheckOutputBytes + 100 * 1024 * 1024)) {
  finish("CAPACITY_REFUSED", 2, "Less than bounded small-check output plus 100 MiB free; no command launched");
}
if (named.live || stage === "installed" || stage === "diagnostic") {
  if (free < BigInt(stage === "installed" ? manifest.limits.finalBuildMinimumFreeBytes : manifest.limits.liveMinimumFreeBytes)) {
    finish("CAPACITY_REFUSED", 2, "Registered live/build disk floor not met; no service or build launched");
  }
  finish("NOT_IMPLEMENTED_NOT_RUN", 2, "Live stage has no owner driver in this feature; never report PASS");
}
const run = (label, binary, argv, cwd, heapMiB) => {
  const started = Date.now();
  const child = spawnSync(binary, [`--max-old-space-size=${heapMiB}`, ...argv], {
    cwd, encoding: "utf8", timeout: manifest.limits.smallCheckWallSeconds * 1000,
    maxBuffer: 1024 * 1024, env: { ...process.env, NODE_OPTIONS: "" },
  });
  const text = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  writeFileSync(join(destination, `${label}.log`), text.slice(0, 1024 * 1024), { flag: "wx", mode: 0o600 });
  const step = { label, argv: [binary, ...argv], exitCode: child.status, signal: child.signal,
    elapsedMs: Date.now() - started, outputSha256: sha(text), outputBytes: Buffer.byteLength(text) };
  record.commands.push(step);
  if (child.error || child.status !== 0) finish("FAIL", 1, `${label} failed; original output retained in ${label}.log`);
};
if (stage === "kernel" || stage === "scrutiny") {
  run("kernel", process.execPath, ["./node_modules/tsx/dist/cli.mjs", "scripts/frontier5/x1/kernel.mts"], os, manifest.limits.kernelNodeHeapMiB);
  run("protocols", process.execPath, ["./node_modules/tsx/dist/cli.mjs", "scripts/frontier5/x1/protocol-cases.mts"], os, manifest.limits.kernelNodeHeapMiB);
  run("reconstruction", process.execPath, ["./node_modules/tsx/dist/cli.mjs", "scripts/frontier5/x1/reconstruction-cases.mts"], os, manifest.limits.kernelNodeHeapMiB);
}
if (stage === "static" || stage === "scrutiny") {
  if (!only || only === "typecheck") {
    run("x1-owner-typecheck", process.execPath, ["./node_modules/typescript/bin/tsc", "-p", "scripts/frontier5/x1/tsconfig.oracle.json",
      "--noUnusedLocals", "false", "--noUnusedParameters", "false"], os, manifest.limits.smallCheckNodeHeapMiB);
    run("runner-syntax", process.execPath, ["--check", "finnor-os/scripts/frontier5/x1/verify.mjs"], repo, manifest.limits.smallCheckNodeHeapMiB);
  }
  if (!only || only === "lint") {
    run("oracle-lint", process.execPath, ["node_modules/eslint/bin/eslint.js", "--config",
      "finnor-os/scripts/frontier5/x1/eslint.config.mjs", "--max-warnings=0",
      "finnor-os/packages/private-equity/src/institution-program/contracts.ts",
      "finnor-os/packages/private-equity/src/institution-program/checker.ts",
      "finnor-os/packages/private-equity/src/institution-program/checker-raw.ts",
      "finnor-os/packages/private-equity/src/institution-program/source-decoder.ts",
      "finnor-os/packages/private-equity/src/institution-program/reconstruction.ts",
      "finnor-os/packages/private-equity/src/institution-program/owner-admission.ts",
      "finnor-os/scripts/frontier5/x1/kernel.mts",
      "finnor-os/scripts/frontier5/x1/protocol-cases.mts",
      "finnor-os/scripts/frontier5/x1/reconstruction-cases.mts"], repo, manifest.limits.smallCheckNodeHeapMiB);
  }
}
if (stage !== "kernel" && stage !== "static" && stage !== "scrutiny") {
  finish("NOT_IMPLEMENTED_NOT_RUN", 2, "This frozen stage has no implementation in this feature");
}
if (stage === "scrutiny") {
  finish("INCOMPLETE_NOT_RUN", 2, "Offline kernel/static passed; required owner, mounted, installed and protected stages have no evidence");
}
finish("DEVELOPMENT_OFFLINE_PASS", 0,
  "Selected bounded offline commands passed; owner persistence, installed bytes and protected qualification remain NOT RUN");
