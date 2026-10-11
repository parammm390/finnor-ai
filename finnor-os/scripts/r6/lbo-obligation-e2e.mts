import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as uw from "../../packages/underwriting/src/index";
import { r6Sha256 } from "../../packages/epistemic-runtime/src/verified-capital-compiler/index";
import type { R6NativeIdentity } from "../../packages/shared-types/src/decision-proof";

const args = process.argv.slice(2);
const evidence = resolve(args[args.indexOf("--evidence") + 1]!);
const source = resolve(args[args.indexOf("--source-evidence") + 1]!);
const repo = resolve(process.env.R6_REPOSITORY_ROOT!);
const deps = resolve(process.env.R6_DEPS_ROOT!);
const owned = join(repo, "scope-r/r6-verified-capital-compiler/evidence-private/");
assert(evidence.startsWith(owned) && source.startsWith(owned) && evidence !== source);
const checker = join(repo, "finnor-os/packages/epistemic-runtime/src/verified-capital-compiler/lbo-obligation-checker.py");
const started = performance.now();
const results: Array<Record<string, unknown>> = [];
let retainedBytes = 0;
async function retain(path: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, null, 2) + "\n";
  retainedBytes += Buffer.byteLength(serialized);
  assert(retainedBytes <= 32 * 1024 * 1024, "Registered evidence byte bound");
  await writeFile(path, serialized, { flag: "wx" });
}
type NativeCase = {
  config: uw.StandardLboModelConfig; model: uw.UnderwritingModelIR;
  compiled: uw.CompiledUnderwritingModel; snapshot: uw.UnderwritingInputSnapshot;
  domain: import("../../packages/shared-types/src/decision-proof").R6InputDomain;
  inventory: import("../../packages/shared-types/src/decision-proof").R6ReferenceState[];
  result: uw.UnderwritingRunResult;
};
type Packet = {
  schema: "finnor.r6.lbo-totality-obligation.v1"; native: NativeCase;
  nativeIdentity: R6NativeIdentity;
  numericPolicy: { precision: number; rounding: number; minE: number; maxE: number };
  claim: {
    rule: string; minimumRate: string; flowIndex: number; minimumExponent: number;
    scope: string; noFinancialAcceptance: boolean; domainDigest: string;
    axioms: never[]; unresolvedGoals: never[];
  };
};
type Receipt = {
  schema: string; disposition: string; predicate: string;
  packetDigest: string; checkerDigest: string;
  allInputFinancialProofPassed: boolean; successfulUniversalValidityDisproved?: boolean;
  certifiedLateExitSetInUnchangedDomain?: string[];
  physical: { pid: number; parentPid: number; executableDigest: string };
};
function bind(packet: Packet): void {
  packet.claim.domainDigest = uw.semanticHash(packet.native.domain);
}
async function invoke(packet: Packet, dir: string): Promise<Receipt> {
  const serialized = uw.canonicalSerialize(packet);
  assert(Buffer.byteLength(serialized) <= 8 * 1024 * 1024);
  await retain(join(dir, "packet.json"), packet);
  const command = ["/usr/bin/python3", "-I", "-B", checker, "--repo", repo,
    "--decimal-module", join(deps, "decimal.js/decimal.mjs"), "--packet", "-"];
  const child = spawn(command[0]!, command.slice(1), {
    cwd: repo, env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1", LANG: "C.UTF-8" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", processError: Error | null = null, timeout = false;
  let outputBytes = 0;
  const timer = setTimeout(() => { timeout = true; child.kill("SIGKILL"); }, 30000);
  child.stdout.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 8 * 1024 * 1024) { child.kill("SIGKILL"); return; }
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(stderr) + chunk.length > 262144) { child.kill("SIGKILL"); return; }
    stderr += chunk.toString("utf8");
  });
  child.stdin.on("error", error => { processError = error; });
  const exit = new Promise<number | null>(finish => {
    child.once("error", error => { processError = error; });
    child.once("close", code => finish(code));
  });
  child.stdin.end(serialized);
  const code = await exit;
  clearTimeout(timer);
  await retain(join(dir, "process.json"), { command, pid: child.pid, code, timeout,
    processError: processError ? String(processError) : null, stdout, stderr });
  assert(!processError && !timeout && code === 0 && outputBytes <= 8 * 1024 * 1024, stderr);
  const receipt = JSON.parse(stdout) as Receipt;
  assert.equal(receipt.schema, "finnor.r6.lbo-totality-obligation-receipt.v1");
  assert.equal(receipt.packetDigest, uw.semanticHash(packet));
  assert.equal(receipt.checkerDigest, `sha256:${r6Sha256(await readFile(checker))}`);
  assert.equal(receipt.physical.pid, child.pid);
  assert.equal(receipt.physical.parentPid, process.pid);
  assert.equal(receipt.physical.executableDigest,
    "sha256:e7276a0ac27acdd53135450bd3038e8a6d77aad9df9ee06b05ef311ce9955db9");
  assert.equal(receipt.allInputFinancialProofPassed, false, "A negative checker must never issue financial acceptance");
  await retain(join(dir, "receipt.json"), receipt);
  return receipt;
}
async function caseRun(id: string, packet: Packet, expected: "DISPROVED" | "REJECTED"): Promise<Receipt> {
  const dir = join(evidence, id);
  await mkdir(dir);
  const receipt = await invoke(packet, dir);
  assert.equal(receipt.disposition, expected, JSON.stringify(receipt));
  if (expected === "DISPROVED") {
    assert.equal(receipt.successfulUniversalValidityDisproved, true);
    assert.equal(receipt.predicate, "NATIVE_PERIODIC_IRR_LOWER_NPV_UNDERFLOW");
    assert(receipt.certifiedLateExitSetInUnchangedDomain?.length);
  }
  results.push({ id, engineeringCheck: "PASS", obligationDisposition: receipt.disposition,
    predicate: receipt.predicate, packetDigest: receipt.packetDigest });
  console.log(`${id}: ${receipt.disposition}/${receipt.predicate} (not financial acceptance)`);
  return receipt;
}
async function main(): Promise<void> {
  const disk = await statfs(repo);
  assert(Number(disk.bavail) * Number(disk.bsize) >= 256 * 1024 * 1024);
  const sourceCut = JSON.parse(await readFile(join(source, "source-cut.json"), "utf8")) as {
    identity: R6NativeIdentity; numericPolicy: Packet["numericPolicy"];
  };
  const nativeSummary = JSON.parse(await readFile(join(source, "summary.json"), "utf8")) as {
    engineeringChecks: string; cases: Array<{ id: string; nativeStatus: string }>;
  };
  assert.equal(nativeSummary.engineeringChecks, "PASS_REGISTERED_OBSERVATIONS");
  await retain(join(evidence, "source-cut.json"), {
    head: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    tree: execFileSync("git", ["-C", repo, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
    status: execFileSync("git", ["-C", repo, "status", "--short"], { encoding: "utf8" }),
    runnerSha256: r6Sha256(await readFile(new URL(import.meta.url))),
    checkerSha256: r6Sha256(await readFile(checker)),
    sourceProbe: source, sourceSummarySha256: r6Sha256(await readFile(join(source, "summary.json"))),
    originalCoreSummarySha256: r6Sha256(await readFile(join(owned, "core-005/summary.json"))),
  });
  const packetFor = async (id: string): Promise<Packet> => {
    const native = JSON.parse(await readFile(join(source, id, "native.json"), "utf8")) as NativeCase;
    return {
      schema: "finnor.r6.lbo-totality-obligation.v1", native,
      nativeIdentity: sourceCut.identity, numericPolicy: sourceCut.numericPolicy,
      claim: {
        rule: "NATIVE_LOWER_NPV_SATURATION_DISPROVES_TOTALITY",
        minimumRate: "-0.999999999999", flowIndex: 9, minimumExponent: -100,
        scope: "EVERY_STANDARD_LBO_INPUT_WITH_EXIT_ORDINAL_GE_9",
        noFinancialAcceptance: true, domainDigest: uw.semanticHash(native.domain),
        axioms: [], unresolvedGoals: [],
      },
    };
  };
  const failed = nativeSummary.cases.filter(c => c.nativeStatus === "FAILED");
  assert.equal(failed.length, 7);
  for (const observed of failed) await caseRun(`negative-${observed.id}`, await packetFor(observed.id), "DISPROVED");
  for (const id of ["annual-8-late-exit", "annual-12-earlier-exit-control"]) {
    await caseRun(`noncounterexample-${id}`, await packetFor(id), "REJECTED");
  }
  const original = await packetFor("annual-12-late-exit");
  const mutations: Array<[string, (packet: Packet) => void]> = [
    ["fabricated-native-success", p => {
      p.native.result.status = "SUCCEEDED"; p.native.result.validity = "VALID";
      const { resultSemanticHash: _digest, ...body } = p.native.result;
      p.native.result.resultSemanticHash = uw.semanticHash(body);
    }],
    ["changed-lower-endpoint", p => { p.claim.minimumRate = "-0.9"; }],
    ["wrong-exponent", p => { p.claim.flowIndex = 8; }],
    ["changed-live-exponent-range", p => { p.numericPolicy.minE = -1000; }],
    ["narrowed-original-domain", p => {
      p.native.domain.inputs.find(b => b.programmeNodeId === "exit.period_id")!.components.$scalar =
        { kind: "ENUMERATION", values: [p.native.compiled.periods[0]!.id] };
      bind(p);
    }],
    ["missing-native-liability", p => {
      p.native.inventory = p.native.inventory.filter(s => s.nodeId !== "debt.total.ending_principal");
    }],
    ["missing-irr-objective", p => {
      p.native.inventory = p.native.inventory.filter(s => s.nodeId !== "gross_sponsor_irr");
    }],
    ["shifted-native-period", p => { p.native.compiled.periods[0]!.endDate = "2026-12-30"; }],
    ["unapproved-axiom", p => { (p.claim.axioms as unknown[]).push("IGNORE_NATIVE_UNDERFLOW"); }],
    ["unresolved-goal", p => { (p.claim.unresolvedGoals as unknown[]).push("NATIVE_TOTALITY"); }],
    ["wrong-native-source-pin", p => { p.nativeIdentity.sourcePins[0]!.sha256 = "0".repeat(64); }],
    ["duplicate-native-input-owner", p => {
      p.native.domain.inputs[1]!.ownerRef = structuredClone(p.native.domain.inputs[0]!.ownerRef); bind(p);
    }],
  ];
  assert.equal(mutations.length, 12);
  for (const [id, mutate] of mutations) {
    const packet = structuredClone(original);
    mutate(packet);
    await caseRun(`mutation-${id}`, packet, "REJECTED");
  }
  // Exact diagnostic repair: use a polynomial-scaled NPV instead of dividing
  // by underflowed powers. It has opposite endpoint signs and no denominator.
  // This is NOT the native ordered function and is NOT installed as a proof.
  const raw = JSON.parse(await readFile(join(source, "annual-12-late-exit/return-boundary.json"), "utf8")) as {
    flows: uw.SponsorCashFlow[];
  };
  const horner = (rate: string): { text: string; finite: boolean } => {
    const base = uw.d(rate).plus(1);
    let value = uw.d(raw.flows[0]!.amount);
    for (const flow of raw.flows.slice(1)) value = value.times(base).plus(uw.d(flow.amount));
    return { text: value.toFixed(), finite: value.isFinite() };
  };
  const lower = horner(uw.RETURN_SOLVER_POLICY.minimumRate);
  const upper = horner(uw.RETURN_SOLVER_POLICY.maximumRate);
  assert(lower.finite && upper.finite && uw.cmp(lower.text, "0") > 0 && uw.cmp(upper.text, "0") < 0);
  await retain(join(evidence, "diagnostic-polynomial-repair.json"), {
    lower, upper, originalAlgorithmChanged: true, nativeOwnerFilesModified: false,
    allowedAsNativeEquivalenceProof: false,
    reason: "Horner/scaled-NPV changes the ordered Decimal computation, saturation and normalization points; no congruence rule permits substituting it for original returns.ts.",
  });
}
let failure: unknown = null;
try { await main(); } catch (error) { failure = error; console.error(error); }
await retain(join(evidence, "summary.json"), {
  schema: "finnor.r6.lbo-totality-obligation-e2e.v1",
  engineeringChecks: failure ? "FAIL" : "PASS_NEGATIVE_OBLIGATION_CHECKS_ONLY",
  cases: results, failure: failure ? String(failure) : null,
  elapsedMs: Math.round(performance.now() - started), retainedBytes,
  successfulStandardLboFinancialProof: "BLOCKED_FALSE_NATIVE_TOTALITY_OBLIGATION_IF_LATE_EXIT_IS_IN_D",
  originalDomainNarrowed: false, originalNativeCodeModified: false,
  referenceApproval: "NOT_ESTABLISHED", checkerAdmission: "NOT_ESTABLISHED",
});
if (failure) process.exitCode = 1;
