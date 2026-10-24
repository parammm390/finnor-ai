/** Failure-first finite OFFLINE process replay. No DB/Auth/queue is simulated.
 * Defined before the native correction. Reports and inputs are immutable. */
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const p = a.indexOf("="); return [a.slice(0, p), a.slice(p + 1)];
}));
if (!args["--output"] || !isAbsolute(args["--output"])) throw Error("Absolute --output required");
const output = args["--output"];
await mkdir(output, { recursive: false });
const report: Record<string, unknown> = {
  schema: "finnor.z3.native-boundary-e2e.v1", status: "FAIL",
  scope: "REAL_OFFLINE_PRODUCER_CHECKER_AND_PROCESS_BOUNDARIES_NOT_NATIVE_DB_PROOF",
  cases: [], nativeOwner: "NOT_RUN", installedNative: "NOT_RUN",
  protectedAdmission: "NOT_RUN", financialQualification: "NOT_RUN",
};
const cases = report.cases as Array<Record<string, unknown>>;
let temporary: string | undefined;
try {
  const assets = await import("../../../packages/private-equity/src/project-z/z3-viability/assets");
  const processes = await import("../../../packages/private-equity/src/project-z/z3-viability/process");
  const contracts = await import("../../../packages/private-equity/src/project-z/z3-viability/contracts");
  const nativeModel = await import("../../../packages/private-equity/src/project-z/z3-viability/native-model");
  const revision = await import("../../../packages/orchestration/src/project-z/z3-viability/revision");
  const producerBundle = args["--cli"] ?? join(repo, "scope-z/phase-evidence/z3/build/cli.mjs");
  const checkerSource = join(repo, "finnor-os/packages/epistemic-runtime/src/project-z/z3-viability/checker.py");
  const pinned = await assets.pinViabilityToolchain({ producerBundle, checkerSource });
  report.build = pinned.identity;
  const inventory: Record<string, string> = {};
  for (const directory of ["finnor-os/packages/private-equity/src/project-z/z3-viability",
    "finnor-os/packages/orchestration/src/project-z/z3-viability",
    "finnor-os/packages/epistemic-runtime/src/project-z/z3-viability"]) {
    for (const name of (await readdir(join(repo, directory))).sort()) {
      if (/\.(ts|py)$/.test(name)) inventory[directory + "/" + name] = createHash("sha256")
        .update(await readFile(join(repo, directory, name))).digest("hex");
    }
  }
  report.sourceInventory = inventory;
  temporary = await mkdtemp(join(tmpdir(), "z3-boundary-"));
  const expectFault = async (id: string, expected: string, work: () => Promise<unknown>, closed = false) => {
    try { await work(); throw Error("EXPECTED_REFUSAL_MISSING:" + id); }
    catch (e) {
      const error = e as Error & { code?: string; observation?: { closed?: boolean; signal?: string } };
      if (error.code !== expected || closed && error.observation?.closed !== true) throw e;
      cases.push({ id, expected, actual: error.code, observation: error.observation ?? null, passed: true });
    }
  };
  const frozen = JSON.parse(await readFile(join(repo, "scope-z/phase-evidence/z3/frozen-public-cases-v2.json"), "utf8"));
  const population = Array.isArray(frozen) ? frozen : frozen.cases;
  const useful = population.find((c: any) => c.obligation === "useful" && c.positiveApplicable === true);
  if (!useful) throw Error("FROZEN_USEFUL_POSITIVE_NOT_FOUND");
  const original = { arena: useful.arena, binding: useful.binding };
  await writeFile(join(output, "original.json"), JSON.stringify(original) + "\n", { flag: "wx" });
  const produced = await processes.runViabilityChild({
    command: process.execPath, args: ["--input-type=module", "--eval", pinned.producer.source, "z3-cli", "produce-batch"],
    inputLine: JSON.stringify(original) + "\n", wallMs: 30_000,
  });
  const checked = await processes.runViabilityChild({
    command: pinned.pythonExecutable, args: ["-I", "-c", pinned.checker.source, "--batch"],
    inputLine: JSON.stringify({ ...original, candidate: produced.value }) + "\n", wallMs: 300_000,
  });
  if ((checked.value as any)?.status !== "VIABLE") throw Error("REAL_PRODUCER_CHECKER_POSITIVE_FAILED");
  cases.push({ id: "N00_REAL_PINNED_ROUND_TRIP", passed: true, status: "VIABLE",
    producer: produced.observation, checker: checked.observation });
  await writeFile(join(output, "candidate.json"), JSON.stringify(produced.value) + "\n", { flag: "wx" });
  await writeFile(join(output, "check.json"), JSON.stringify(checked.value) + "\n", { flag: "wx" });
  contracts.parseStoredReceipt(checked.value);
  await expectFault("N09_FORGED_VIABLE_OBLIGATIONS", "Z3_CHECK_VIABLE_OBLIGATIONS_MISSING",
    async () => contracts.parseStoredReceipt({ ...(checked.value as object), safety: false }));
  process.env.FINNOR_Z3_PYTHON = join(temporary, "caller-python");
  try {
    await expectFault("N07_CALLER_INTERPRETER", "Z3_CALLER_SELECTED_INTERPRETER_UNSUPPORTED",
      () => assets.pinViabilityToolchain({ producerBundle, checkerSource }));
  } finally { delete process.env.FINNOR_Z3_PYTHON; }
  const model = nativeModel.parseNativeOriginalInstruction(await readFile(
    join(repo, "finnor-os/scripts/project-z/z3/native-original-example.json"), "utf8"));
  const nativeOriginal = { arena: model.arena, binding: useful.binding };
  const nativeCandidate = await processes.runViabilityChild({ command: process.execPath,
    args: ["--max-old-space-size=512", "--input-type=module", "--eval", pinned.producer.source, "z3-cli", "produce-batch"],
    inputLine: JSON.stringify(nativeOriginal) + "\n", wallMs: 30000 });
  const nativeCheck = await processes.runViabilityChild({ command: pinned.pythonExecutable,
    args: ["-I", "-c", pinned.checker.source, "--batch"],
    inputLine: JSON.stringify({ ...nativeOriginal, candidate: nativeCandidate.value }) + "\n", wallMs: 300000 });
  const nativeReceipt = contracts.parseStoredReceipt(nativeCheck.value);
  if (nativeReceipt.status !== "VIABLE") throw Error("PUBLIC_NATIVE_PROFILE_ORIGINAL_SEMANTICS_FAILED");
  cases.push({ id: "N14_PUBLIC_NATIVE_PROFILE_PROCESS_ROUND_TRIP_NOT_OWNER_PROOF", passed: true,
    originalArenaDigest: contracts.hash(model.arena), independentCheck: nativeReceipt.status });
  const complete = contracts.parseStoredCandidate(nativeCandidate.value);
  if (complete.disposition !== "COMPLETE") throw Error("NATIVE_PUBLIC_CANDIDATE_INCOMPLETE");
  const bridgeInput = { previousSessionId: "PUBLIC_PREVIOUS_NOT_NATIVE", previousBinding: useful.binding,
    binding: { ...useful.binding, sourceRevision: "PUBLIC_NEW_REVISION" }, previousArena: model.arena, arena: model.arena,
    previousReservation: { publicFixture: true }, reservation: { publicFixture: true },
    strategy: complete.strategy, cursor: { stateId: model.arena.initial[0]!, memory: complete.strategy.initial[0]!,
      operations: 8, goalVisits: { READINESS: 4, RECONCILE: 4 } } };
  const bridge = revision.originalViabilityIdentityRefinement(bridgeInput);
  if (bridge.candidateReuseAllowed || bridge.newAllowance || bridge.cursor.operations !== 8) throw Error("N18_BRIDGE_RESET_OR_REUSE");
  await expectFault("N18_RENEWED_PARENT_REFUSED", "Z3_ORIGINAL_BEHAVIOR_REVISION_BRIDGE_REQUIRED", async () => {
    try { revision.originalViabilityIdentityRefinement({ ...bridgeInput,
      binding: { ...bridgeInput.binding, originalParentId: "PUBLIC_REPLACEMENT_PARENT" } }); }
    catch (error) { throw new contracts.Z3NativeFault((error as Error).message); }
  });
  cases.push({ id: "N18_IDENTITY_REFINEMENT_NOT_NATIVE_REVISION_PROOF", passed: true, bridgeDigest: contracts.hash(bridge) });
  const fakeChecker = join(temporary, "fake-checker.py");
  await writeFile(fakeChecker, 'print(\'{"schema":"finnor.z3.independent-check.v1","status":"VIABLE"}\')\n', { flag: "wx" });
  await expectFault("N06_FORGED_CHECKER", "Z3_CHECKER_ASSET_NOT_APPROVED",
    () => assets.pinViabilityToolchain({ producerBundle, checkerSource: fakeChecker }));
  const fakeProducer = join(temporary, "fake-producer.mjs");
  await writeFile(fakeProducer, 'process.stdout.write("{}\\n")\n', { flag: "wx" });
  await expectFault("N07_FORGED_PRODUCER", "Z3_PRODUCER_ASSET_NOT_APPROVED",
    () => assets.pinViabilityToolchain({ producerBundle: fakeProducer, checkerSource }));
  const copiedChecker = join(temporary, "checker.py");
  await copyFile(checkerSource, copiedChecker);
  const copied = await assets.pinViabilityToolchain({ producerBundle, checkerSource: copiedChecker });
  await writeFile(copiedChecker, "# replaced after pin\n");
  await expectFault("N08_REVALIDATE_AFTER_PIN", "Z3_CHECKER_ASSET_NOT_APPROVED", () => copied.revalidate());
  const captured = await processes.runViabilityChild({
    command: copied.pythonExecutable, args: ["-I", "-c", copied.checker.source, "--batch"],
    inputLine: JSON.stringify({ ...original, candidate: produced.value }) + "\n", wallMs: 300_000,
  });
  if ((captured.value as any)?.status !== "VIABLE") throw Error("CAPTURED_BYTES_NOT_EXECUTED");
  cases.push({ id: "N08_CAPTURED_VERIFIED_BYTES_NO_PATH_REREAD", passed: true });
  for (const [id, program, expected, options] of [
    ["N04_ABORT_WAITS_FOR_PHYSICAL_CLOSE", "setInterval(()=>{},1000)", "Z3_CHILD_ABORTED", { abort: true }],
    ["N05_ORIGINAL_REMAINING_DEADLINE", "setInterval(()=>{},1000)", "Z3_CHILD_TIMEOUT", { wallMs: 40 }],
    ["N09_MULTIPLE_PROTOCOL_ROWS", 'console.log("{}\\n{}")', "Z3_CHILD_PROTOCOL_ROWS", {}],
    ["N09_OUTPUT_BOUND", 'process.stdout.write("x".repeat(16384));setInterval(()=>{},1000)', "Z3_CHILD_OUTPUT_BOUND", { maxOutputBytes: 1024 }],
    ["N09_MALFORMED_PROTOCOL", 'console.log("not-json")', "Z3_CHILD_OUTPUT_MALFORMED", {}],
    ["N09_CHILD_EXIT", "process.exit(7)", "Z3_CHILD_EXIT_NONZERO", {}],
  ] as const) {
    const controller = new AbortController();
    const timer = "abort" in options ? setTimeout(() => controller.abort(), 150) : undefined;
    try {
      await expectFault(id, expected, () => processes.runViabilityChild({
        command: process.execPath, args: ["--eval", program], inputLine: "",
        wallMs: "wallMs" in options ? options.wallMs : 5000,
        maxOutputBytes: "maxOutputBytes" in options ? options.maxOutputBytes : undefined,
        signal: controller.signal,
      }), true);
    } finally { if (timer) clearTimeout(timer); }
  }
  process.env.FINNOR_Z3_BOUNDARY_SECRET_SENTINEL = "must-not-be-inherited";
  try {
    const observed = await processes.runViabilityChild({
      command: process.execPath,
      args: ["--eval", 'console.log(JSON.stringify({leaked:Boolean(process.env.FINNOR_Z3_BOUNDARY_SECRET_SENTINEL)}))'],
      inputLine: "", wallMs: 5000,
    });
    if ((observed.value as any)?.leaked !== false) throw Error("CHILD_INHERITED_SECRET_ENVIRONMENT");
    cases.push({ id: "N07_CHILD_ENVIRONMENT_ALLOWLIST", passed: true, observation: observed.observation });
  } finally { delete process.env.FINNOR_Z3_BOUNDARY_SECRET_SENTINEL; }
  await pinned.revalidate();
  report.status = "PASS";
} catch (error) {
  report.failure = error instanceof Error ? { name: error.name, message: error.message } : { name: "UNKNOWN" };
  process.exitCode = 1;
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
  const body = JSON.stringify(report, null, 2) + "\n";
  await writeFile(join(output, "report.json"), body, { flag: "wx" });
  console.log(JSON.stringify({ status: report.status, cases: cases.length,
    reportDigest: createHash("sha256").update(body).digest("hex"), failure: report.failure ?? null }));
}
