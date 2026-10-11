import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalSerialize, semanticHash } from "../../../underwriting/src/canonical";
import type { R6CheckerReceipt } from "../../../shared-types/src/decision-proof";
import type { R6CheckerOptions, R6CheckerTranscript, R6ProofPacket } from "./contracts";
import { R6_LIMITS } from "./contracts";
import { R6_LBO_V2_CHECKER_DEPENDENCIES, r6Sha256 } from "./native";

function unknownReceipt(packet: R6ProofPacket, predicate: string, reason: string): R6CheckerReceipt {
  return {
    schema: "finnor.r6.independent-check.v1", disposition: "UNKNOWN", predicate, reason,
    packetDigest: semanticHash(packet), proofDigest: semanticHash(packet.proof),
    checkerDigest: packet.nativeIdentity.checkerDigest,
    nativeIdentityDigest: semanticHash(packet.nativeIdentity),
    allInputEquivalence: false, universallyValid: false, nonemptyDomain: false,
    domainCardinality: null, checkedInvariants: [],
    coverage: { nativeNodes: 0, financialStates: 0, periods: 0, terms: 0 },
    witnessValues: null, witnessChecks: [],
    basis: "INDEPENDENT_ORDERED_TERM_CONGRUENCE_EXACT_FRACTION_ENCLOSURES",
    qualification: "ORDINARY_DEVELOPMENT_EVIDENCE_NOT_ADMITTED", physical: null,
  };
}

function validateReceipt(value: unknown, packet: R6ProofPacket): R6CheckerReceipt {
  if (!value || typeof value !== "object") throw new Error("Checker response is not an object");
  const r = value as R6CheckerReceipt;
  if (r.schema !== "finnor.r6.independent-check.v1"
    || !["ACCEPTED", "REJECTED", "INCOMPLETE", "UNSUPPORTED", "UNKNOWN"].includes(r.disposition)
    || r.packetDigest !== semanticHash(packet) || r.proofDigest !== semanticHash(packet.proof)
    || r.checkerDigest !== packet.nativeIdentity.checkerDigest
    || r.nativeIdentityDigest !== semanticHash(packet.nativeIdentity)
    || r.basis !== "INDEPENDENT_ORDERED_TERM_CONGRUENCE_EXACT_FRACTION_ENCLOSURES"
    || r.qualification !== "ORDINARY_DEVELOPMENT_EVIDENCE_NOT_ADMITTED"
    || typeof r.predicate !== "string" || !Array.isArray(r.checkedInvariants)
    || !r.coverage || !r.physical || !Number.isSafeInteger(r.physical.pid)) {
    throw new Error("Checker response identity/schema does not bind the actual packet and checker");
  }
  if (r.disposition === "ACCEPTED" && (
    r.allInputEquivalence !== true || r.universallyValid !== true || r.nonemptyDomain !== true
    || !r.domainCardinality || !/^[1-9][0-9]*$/.test(r.domainCardinality)
    || r.checkedInvariants.length < 6
  )) throw new Error("Checker acceptance is missing its complete universal predicates");
  return r;
}

/** Two fixed enrolled checker entries selected by the bound native operation;
 * no caller path, shell, alternate checker or producer receipt is accepted. */
export async function checkDecisionProof(
  packet: R6ProofPacket,
  options: R6CheckerOptions,
): Promise<R6CheckerReceipt> {
  const started = performance.now();
  const deadline = Math.min(new Date(options.deadlineAt).getTime(), Date.now() + R6_LIMITS.checkerWallMs);
  const serialized = canonicalSerialize(packet);
  if (Buffer.byteLength(serialized) > R6_LIMITS.packetBytes) {
    return unknownReceipt(packet, "PACKET_BYTES", "Actual proof packet exceeds the bounded checker transport");
  }
  if (!Number.isFinite(deadline) || deadline <= Date.now() || options.signal?.aborted) {
    return unknownReceipt(packet, "CANCELLED_OR_DEADLINE", "Original owner deadline/cancellation prevents checking");
  }
  // The only enrolled development interpreter is the existing OS Python.
  // A caller cannot replace it with a producer script that prints fake PASS.
  const enrolled = await realpath("/usr/bin/python3");
  if (await realpath(options.pythonExecutable).catch(() => "") !== enrolled) {
    return unknownReceipt(packet, "CHECKER_INTERPRETER", "Alternate checker/interpreter is not enrolled");
  }
  let checkerEntry: string;
  try {
    const moduleDirectory = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
    const specializedV2 = packet.programme.runtime?.kind === "standard_lbo_v1"
      && packet.programme.runtime.returnMethod === "decimal34_horner_npv_v2";
    checkerEntry = await realpath(join(moduleDirectory, specializedV2 ? "lbo-v2-checker.py" : "checker.py"));
    if (packet.nativeIdentity.checkerDigest !== `sha256:${r6Sha256(await readFile(checkerEntry))}`) {
      return unknownReceipt(packet, "CHECKER_ENTRY_PIN", "The enrolled checker bytes differ from the proposed native identity");
    }
    if (specializedV2) {
      const pins = packet.nativeIdentity.checkerDependencyPins;
      if (packet.nativeIdentity.nativeReturnMethod !== "decimal34_horner_npv_v2"
        || canonicalSerialize(pins?.map(pin => pin.path)) !== canonicalSerialize(R6_LBO_V2_CHECKER_DEPENDENCIES)) {
        return unknownReceipt(packet, "CHECKER_DEPENDENCY_COVERAGE", "Every enrolled specialized helper is a required currentness dependency");
      }
      for (const pin of pins!) if (pin.sha256 !== r6Sha256(await readFile(join(options.repositoryRoot, pin.path)))) {
        return unknownReceipt(packet, "CHECKER_DEPENDENCY_PIN", "The independently loaded helper bytes changed");
      }
    }
  } catch (error) {
    return unknownReceipt(packet, "CHECKER_ENTRY_UNAVAILABLE", String(error));
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0 || options.signal?.aborted) {
    return unknownReceipt(packet, "CANCELLED_OR_DEADLINE", "Original deadline/cancellation elapsed during checker enrollment");
  }
  const command = [
    resolve(options.pythonExecutable), "-I", "-B",
    checkerEntry,
    "--repo", resolve(options.repositoryRoot), "--packet", "-",
    "--decimal-module", resolve(options.decimalModulePath),
  ];
  let stdout = "", stderr = "", overflow = false, timedOut = false, cancelled = false;
  let spawnError: string | null = null;
  let stdoutBytes = 0, stderrBytes = 0;
  const child = spawn(command[0]!, command.slice(1), {
    cwd: resolve(options.repositoryRoot),
    env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1", LANG: "C.UTF-8", NODE_ENV: process.env.NODE_ENV ?? "production" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const timeout = setTimeout(() => {
    timedOut = true; child.kill("SIGKILL");
  }, remaining);
  const cancel = (): void => { cancelled = true; child.kill("SIGKILL"); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  child.once("spawn", () => {
    try { if (child.pid) options.onChildStarted?.(child.pid); }
    catch (error) { spawnError = String(error); child.kill("SIGKILL"); }
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > R6_LIMITS.packetBytes) { overflow = true; child.kill("SIGKILL"); return; }
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 262_144) { overflow = true; child.kill("SIGKILL"); return; }
    stderr += chunk.toString("utf8");
  });
  // A process crash may close stdin while a bounded packet is still being sent.
  child.stdin.on("error", error => { spawnError ??= String(error); });
  const ended = new Promise<{ code: number | null; signal: string | null }>(resolveEnd => {
    child.once("error", error => { spawnError = String(error); });
    child.once("close", (code, signal) => resolveEnd({ code, signal }));
  });
  child.stdin.end(serialized);
  const exit = await ended;
  clearTimeout(timeout);
  options.signal?.removeEventListener("abort", cancel);
  let receipt: R6CheckerReceipt;
  if (cancelled || timedOut || overflow || spawnError || exit.code !== 0) {
    const predicate = cancelled ? "CHECKER_CANCELLED" : timedOut ? "CHECKER_TIMEOUT"
      : overflow ? "CHECKER_OUTPUT_BOUND" : "CHECKER_PROCESS_FAILURE";
    receipt = unknownReceipt(packet, predicate, spawnError ?? `Exit ${String(exit.code)} / ${String(exit.signal)}`);
  } else {
    try {
      receipt = validateReceipt(JSON.parse(stdout), packet);
      if (receipt.physical!.pid !== child.pid || receipt.physical!.parentPid !== process.pid) {
        throw new Error("Checker receipt does not bind the actual child and parent PIDs");
      }
      const executable = await realpath(receipt.physical!.executable);
      const applePython = await realpath("/Library/Developer/CommandLineTools/usr/bin/python3").catch(() => "");
      if (![enrolled, applePython].includes(executable)
        || receipt.physical!.executableDigest !== `sha256:${r6Sha256(await readFile(executable))}`) {
        throw new Error("Checker receipt does not bind the enrolled actual Python executable");
      }
    }
    catch (error) { receipt = unknownReceipt(packet, "CHECKER_RESPONSE", String(error)); }
  }
  if (options.signal?.aborted || cancelled) {
    receipt = unknownReceipt(packet, "CHECKER_CANCELLED", "Original cancellation remains authoritative through receipt validation");
  } else if (Date.now() >= deadline || performance.now() - started >= R6_LIMITS.checkerWallMs) {
    receipt = unknownReceipt(packet, "CHECKER_TIMEOUT", "Original checker deadline elapsed before receipt validation completed");
  }
  const transcript: R6CheckerTranscript = {
    packetDigest: semanticHash(packet), command, pid: child.pid ?? null,
    exitCode: exit.code, signal: exit.signal, stdout, stderr,
    elapsedMs: Math.round(performance.now() - started), disposition: receipt.disposition,
  };
  try { await options.retainTranscript?.(transcript); }
  catch (error) { return unknownReceipt(packet, "CHECKER_TRANSCRIPT_RETENTION", String(error)); }
  if (options.signal?.aborted) {
    return unknownReceipt(packet, "CHECKER_CANCELLED", "Original cancellation occurred during checker transcript retention");
  }
  if (Date.now() >= deadline || performance.now() - started >= R6_LIMITS.checkerWallMs) {
    return unknownReceipt(packet, "CHECKER_TIMEOUT", "Original deadline elapsed during checker transcript retention");
  }
  return receipt;
}
