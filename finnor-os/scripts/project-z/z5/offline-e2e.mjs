import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, lstat, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const kernel = path.join(root, "finnor-os/packages/epistemic-runtime/src/project-z/z5-institution-linker/kernel.ts");
const checker = path.join(path.dirname(kernel), "checker.py");
const frozen = path.join(root, "scope-z/phase-evidence/z5/frozen");
const args = process.argv.slice(2);
const auditOnly = args.length === 2 && args[0] === "--audit-only";
const requestedOutput = auditOnly ? args[1] : args.length === 1 ? args[0] : null;
const evidenceRoot = await realpath(path.join(root, "scope-z/phase-evidence/z5"));
const inside = (parent, file) => {
  const relative = path.relative(parent, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
if (!requestedOutput || !path.isAbsolute(requestedOutput) || !inside(evidenceRoot, path.resolve(requestedOutput)))
  throw Error("EXPLICIT_OWNED_EVIDENCE_DIRECTORY_REQUIRED");
const output = path.join(await realpath(path.dirname(path.resolve(requestedOutput))), path.basename(path.resolve(requestedOutput)));
if (!inside(evidenceRoot, output)) throw Error("EXPLICIT_OWNED_EVIDENCE_DIRECTORY_REQUIRED");
await mkdir(output, { recursive: false, mode: 0o700 });
const startedAt = new Date().toISOString();
const startedWall = performance.now();
const hash = value => createHash("sha256").update(value).digest("hex");
const code = {};
for (const file of [kernel, checker, fileURLToPath(import.meta.url)])
  code[path.relative(root, file)] = hash(await readFile(file));
const registrationBytes = await readFile(path.join(frozen, "registration.json"));
if (hash(registrationBytes) !== "74c0d1b3f02e53e3c011f4cf5f976dd62378e04d2fd56b389973078cf6b2f42e")
  throw Error("ORIGINAL_FROZEN_REGISTRATION_CHANGED");
const registration = JSON.parse(registrationBytes);
const familyFile = path.join(root, "scope-z/prompts/qualification-families.json");
const familyBytes = await readFile(familyFile);
const familyTitles = JSON.parse(familyBytes).phases.Z5.families;
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
async function auditPopulation() {
  const start = performance.now();
  if (registration.schema !== "finnor.z5.pre-code-registration.v1" || registration.families !== 32
      || registration.casesPerFamily !== 8 || registration.entries?.length !== 256
      || !Array.isArray(familyTitles) || familyTitles.length !== 32 || new Set(familyTitles).size !== 32)
    throw Error("ORIGINAL_FROZEN_POPULATION_SHAPE");
  const cases = [], seen = new Set(), byInput = new Map();
  let bytesRead = 0;
  for (const entry of registration.entries) {
    const match = /^F(0[1-9]|[12][0-9]|3[0-2])-(0[1-8])$/.exec(entry.id);
    if (!match || seen.has(entry.id) || entry.path !== entry.id + ".json" || !/^[a-f0-9]{64}$/.test(entry.sha256))
      throw Error("ORIGINAL_FROZEN_MEMBER_IDENTITY");
    seen.add(entry.id);
    const file = path.join(frozen, entry.path), info = await lstat(file);
    if (!info.isFile() || info.size > 1024 * 1024) throw Error("ORIGINAL_FROZEN_MEMBER_KIND_OR_BOUND:" + entry.id);
    const bytes = await readFile(file);
    bytesRead += bytes.length;
    if (bytesRead > 64 * 1024 * 1024) throw Error("ORIGINAL_FROZEN_POPULATION_BYTE_BOUND");
    if (hash(bytes) !== entry.sha256) throw Error("FROZEN_CASE_CHANGED:" + entry.id);
    const fixture = JSON.parse(bytes);
    if (fixture.schema !== "finnor.z5.public-frozen-case.v1" || fixture.id !== entry.id
        || fixture.family !== familyTitles[Number(match[1]) - 1]
        || fixture.expected?.disposition !== entry.expected
        || fixture.expected?.usefulSupportedPositive !== entry.usefulSupportedPositive
        || entry.usefulSupportedPositive !== (entry.expected === "CHECKED_CANDIDATE")
        || !["CHECKED_CANDIDATE", "CHECKED_INFEASIBLE", "UNSUPPORTED", "INCOMPLETE"].includes(entry.expected)
        || fixture.input === null || typeof fixture.input !== "object" || Array.isArray(fixture.input))
      throw Error("ORIGINAL_FROZEN_MEMBER_CONTRACT:" + entry.id);
    const inputSha256 = hash(canonical(fixture.input));
    const row = { id: entry.id, familyId: "F" + match[1], family: fixture.family, fixtureSha256: entry.sha256,
      inputSha256, expected: entry.expected, replacement: fixture.expected.replacement ?? null,
      usefulSupportedPositive: entry.usefulSupportedPositive };
    cases.push(row);
    if (!byInput.has(inputSha256)) byInput.set(inputSha256, []);
    byInput.get(inputSha256).push(row);
  }
  const positives = cases.filter(row => row.usefulSupportedPositive).length;
  if (positives !== registration.usefulPositiveDenominator) throw Error("ORIGINAL_FROZEN_POSITIVE_DENOMINATOR");
  const groups = [...byInput].map(([inputSha256, rows]) => ({
    inputSha256, cases: rows.map(row => row.id), familyIds: [...new Set(rows.map(row => row.familyId))],
    expectedOutcomes: [...new Set(rows.map(row => JSON.stringify([row.expected, row.replacement])))].map(value => JSON.parse(value)),
  }));
  const duplicateGroups = groups.filter(group => group.cases.length > 1);
  const perFamily = familyTitles.map((family, i) => {
    const familyId = "F" + String(i + 1).padStart(2, "0"), rows = cases.filter(row => row.familyId === familyId);
    const uniqueOriginalInputs = new Set(rows.map(row => row.inputSha256)).size;
    return { familyId, family, registeredCases: rows.length, uniqueOriginalInputs,
      repeatedOriginalInputSlots: rows.length - uniqueOriginalInputs,
      registeredUsefulPositives: rows.filter(row => row.usefulSupportedPositive).length };
  });
  return {
    schema: "finnor.z5.frozen-population-identity.v1",
    timing: "POST_CODE_STATIC_AUDIT_NOT_A_NEW_SEMANTIC_CAMPAIGN",
    canonicalization: "Recursive UTF-16 lexical object-key order; array order and every input field preserved; JSON.stringify scalar escaping; UTF-8 SHA-256",
    comparisonBoundary: "Equal digests identify exact canonical input duplicates; unequal digests do not establish semantic or structural diversity",
    registrationSha256: hash(registrationBytes), lockedFamilyDefinitionsSha256: hash(familyBytes),
    historicalRegistrationDeclaredProductCodeWritten: registration.productCodeWritten,
    registeredCases: cases.length, registeredFamilyLabels: perFamily.length, registeredUsefulPositives: positives,
    uniqueOriginalInputs: byInput.size, repeatedOriginalInputSlots: cases.length - byInput.size,
    exactDuplicateGroups: duplicateGroups, crossLabelDuplicateGroups: duplicateGroups.filter(group => group.familyIds.length > 1),
    conflictingExpectedOutcomeGroups: groups.filter(group => group.expectedOutcomes.length > 1),
    familiesWithEightDistinctInputs: perFamily.filter(family => family.uniqueOriginalInputs === 8).length,
    structuralFamilyQualification: "NOT_ESTABLISHED", independentlyFreshPopulation: "NOT_ESTABLISHED",
    protectedAdmission: false, originalCasesChanged: 0, newSemanticCaseExecutions: 0,
    bytesRead, wallMs: performance.now() - start, perFamily, cases,
  };
}
async function assertAuditedSourceUnchanged() {
  for (const [relative, digest] of Object.entries(code))
    if (hash(await readFile(path.join(root, relative))) !== digest) throw Error("PUBLIC_RUN_SOURCE_CHANGED:" + relative);
  if (hash(await readFile(path.join(frozen, "registration.json"))) !== hash(registrationBytes)
      || hash(await readFile(familyFile)) !== hash(familyBytes)) throw Error("PUBLIC_POPULATION_INDEX_CHANGED");
}
const populationAudit = await auditPopulation();
if (populationAudit.conflictingExpectedOutcomeGroups.length) throw Error("FROZEN_EXPECTED_OUTCOME_CONFLICT");
await assertAuditedSourceUnchanged();
if (auditOnly) {
  const report = { schema: "finnor.z5.public-population-audit.v1", state: "AUDIT_COMPLETED",
    scope: "POST_CODE_STATIC_ORIGINAL_INPUT_IDENTITY_NOT_NATIVE_OR_PROTECTED", startedAt,
    finishedAt: new Date().toISOString(), elapsedMs: performance.now() - startedWall,
    node: process.version, sourceFiles: code, populationAudit,
    producerExecutions: 0, checkerExecutions: 0, databaseActions: 0, listeners: 0, protectedAdmission: false };
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await new Promise((resolve, reject) => process.stdout.write(JSON.stringify({ output, state: report.state,
    registeredCases: populationAudit.registeredCases, uniqueOriginalInputs: populationAudit.uniqueOriginalInputs,
    structuralFamilyQualification: populationAudit.structuralFamilyQualification, producerExecutions: 0, checkerExecutions: 0 }) + "\n",
  error => error ? reject(error) : resolve()));
  process.exit(0);
}
await writeFile(path.join(output, "population-audit.json"), JSON.stringify(populationAudit, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const receipt = {
  schema: "finnor.z5.public-process-e2e.v1", id: randomUUID(), startedAt,
  scope: "PUBLIC_OFFLINE_ORIGINAL_SEMANTICS_NOT_NATIVE_OR_PROTECTED",
  sourceFiles: code, registrationSha256: hash(registrationBytes), node: process.version,
  populationAudit: { report: "population-audit.json", uniqueOriginalInputs: populationAudit.uniqueOriginalInputs,
    structuralFamilyQualification: populationAudit.structuralFamilyQualification, independentlyFreshPopulation: populationAudit.independentlyFreshPopulation },
  expectedPositiveDenominator: registration.usefulPositiveDenominator, cases: [], failures: [],
  databaseActions: 0, listeners: 0, protectedAdmission: false, state: "IN_PROGRESS",
};
function run(executable, args, input, timeout = 40000) {
  return new Promise(resolve => {
    const child = spawn(executable, args, { cwd: root, env: { PATH: process.env.PATH, LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", limit = false;
    const timer = setTimeout(() => { limit = true; child.kill("SIGKILL"); }, timeout);
    child.stdout.on("data", bytes => { out += bytes; if (Buffer.byteLength(out) > 32 * 1024 * 1024) { limit = true; child.kill("SIGKILL"); } });
    child.stderr.on("data", bytes => { err += bytes; if (Buffer.byteLength(err) > 1024 * 1024) child.kill("SIGKILL"); });
    child.on("error", error => { err += error.code ?? error.name; });
    child.on("close", (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal, timeout: limit, stdout: out, stderr: err }); });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(input));
  });
}
for (const entry of registration.entries) {
  const bytes = await readFile(path.join(frozen, entry.path));
  if (hash(bytes) !== entry.sha256) throw Error("FROZEN_CASE_CHANGED:" + entry.id);
  const fixture = JSON.parse(bytes);
  const start = performance.now();
  const producer = await run(process.execPath, ["--experimental-strip-types", "--max-old-space-size=512", kernel], fixture.input);
  await writeFile(path.join(output, entry.id + ".producer.json"), JSON.stringify(producer) + "\n", { flag: "wx", mode: 0o600 });
  let certificate = null, checked = null, verifier = null, parseError = null;
  try {
    if (producer.exitCode !== 0) throw Error("PRODUCER_EXIT");
    certificate = JSON.parse(producer.stdout);
    verifier = await run("/usr/bin/python3", ["-I", "-B", checker], { input: fixture.input, certificate });
    await writeFile(path.join(output, entry.id + ".checker.json"), JSON.stringify(verifier) + "\n", { flag: "wx", mode: 0o600 });
    checked = JSON.parse(verifier.stdout);
  } catch (error) { parseError = error.message; }
  const passed = producer.exitCode === 0 && verifier?.exitCode === 0 && checked?.checked === true
    && certificate?.disposition === fixture.expected.disposition
    && (!fixture.expected.replacement || certificate?.replacement?.status === fixture.expected.replacement);
  const row = { id: entry.id, family: fixture.family, expected: fixture.expected, disposition: certificate?.disposition,
    replacement: certificate?.replacement?.status ?? null, producerExit: producer.exitCode, checkerExit: verifier?.exitCode ?? null,
    checked: checked?.checked ?? false, checkerReason: checked?.reason ?? null, parseError, passed,
    original: certificate?.original, contextStates: certificate?.context?.states.length ?? 0,
    originalCounterexample: certificate?.originalCounterexample?.kind ?? null,
    costs: certificate?.costs, elapsedMs: performance.now() - start };
  receipt.cases.push(row);
  if (!passed) receipt.failures.push(row.id);
  await writeFile(path.join(output, "progress.json"), JSON.stringify({ finished: receipt.cases.length, failures: receipt.failures }) + "\n", { mode: 0o600 });
}
receipt.positiveAccepted = receipt.cases.filter(c => c.expected.usefulSupportedPositive && c.passed).length;
receipt.positiveRate = receipt.positiveAccepted / receipt.expectedPositiveDenominator;
receipt.allCriticalFalsifiersRejected = receipt.cases.filter(c => !c.expected.usefulSupportedPositive).every(c => c.passed);
receipt.perFamily = [...new Set(receipt.cases.map(c => c.family))].map(family => {
  const cases = receipt.cases.filter(c => c.family === family);
  return { family, cases: cases.length, passed: cases.filter(c => c.passed).length, failures: cases.filter(c => !c.passed).map(c => c.id) };
});
receipt.finishedAt = new Date().toISOString();
receipt.elapsedMs = performance.now() - startedWall;
receipt.state = receipt.failures.length === 0 && receipt.positiveRate >= 0.95 && receipt.allCriticalFalsifiersRejected ? "PASSED" : "FAILED";
await assertAuditedSourceUnchanged();
await writeFile(path.join(output, "report.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ output, state: receipt.state, cases: receipt.cases.length,
  positiveAccepted: receipt.positiveAccepted, denominator: receipt.expectedPositiveDenominator, failures: receipt.failures }));
process.exitCode = receipt.state === "PASSED" ? 0 : 1;
