/** Diagnosed finite-boundary process replay. No DB/Auth/listener authority. */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ROOT, KERNEL, CHECKER, hash, save, evidenceDirectory, producer, checker } from "./e2e-tools.mjs";
import { digest } from "../../../packages/epistemic-runtime/src/project-z/z5-institution-linker/kernel.ts";

if (process.version !== "v22.23.4") throw Error("PINNED_NODE_22_23_4_REQUIRED");
const started = performance.now(), cpu = process.cpuUsage();
const output = await evidenceDirectory(process.argv[2]), rows = [], source = {};
const failureModel = path.join(ROOT, "scope-z/phase-evidence/z5/finite-boundary-failure-model-01.md");
const sourceFiles = [KERNEL, CHECKER, fileURLToPath(import.meta.url),
  fileURLToPath(new URL("./e2e-tools.mjs", import.meta.url)), failureModel];
for (const file of sourceFiles) source[path.relative(ROOT, file)] = hash(await readFile(file));

function originalInput() {
  const component = (id, locations) => ({ id, revision: "fixed-v1",
    states: locations.map(id => ({ id, terminal: true, quiescent: false })),
    transitions: [], assumption: { const: true },
    correspondence: { kind: "BOUNDED_TYPED_KERNEL_V1", scope: "EXACT_LISTED_KERNEL_ONLY",
      admission: "PUBLIC_OFFLINE_FIXED_FIXTURE", implementationDigest: digest([]) }, bridges: [] });
  const first = { locals: { A: "done0", B: "done" }, cells: { world: "0" } };
  return { schema: "finnor.z5.composition-input.v1", claim: "SOUND_SUBSET",
    domain: "PUBLIC_OFFLINE_FIXED_KERNELS", components: [component("A", ["done0", "done1"]), component("B", ["done"])],
    cells: [{ id: "world", identity: "original-world", values: ["0"], kind: "world", public: true, immutable: true }],
    ports: [], initial: [first, { locals: { A: "done1", B: "done" }, cells: { world: "0" } }],
    safety: [{ const: true }], observe: ["world"], excludedEnvironmentActions: [], replacementCandidates: [], live: first,
    limits: { maxProductStates: 2, maxContextStates: 2, maxTransitions: 16,
      maxOperations: 100000, wallMs: 10000, maxRelationPairs: 16, maxTranslationRows: 4096 } };
}
const exact = originalInput(), overflow = originalInput(), duplicate = originalInput();
overflow.limits.maxProductStates = 1;
duplicate.limits.maxProductStates = 1;
duplicate.initial = Array.from({ length: 3 }, () => structuredClone(duplicate.initial[0]));
const large = originalInput();
large.cells = Array.from({ length: 8 }, (_, i) => ({ id: "world" + i, identity: "original-world-" + i,
  values: Array.from({ length: 32 }, (_, j) => String(j)), kind: "world", public: true, immutable: true }));
large.observe = large.cells.map(c => c.id);
large.initial = large.initial.map(s => ({ locals: s.locals, cells: Object.fromEntries(large.cells.map(c => [c.id, "0"])) }));
large.live = structuredClone(large.initial[0]);
large.limits.maxTranslationRows = 1;
const translationExact = originalInput(), translationOverflow = originalInput();
translationExact.limits.maxTranslationRows = 4;
translationOverflow.limits.maxTranslationRows = 3;
const positive = { disposition: "CHECKED_CANDIDATE", originalStates: 2, initialObligations: 2, translationRows: 4 };
const incomplete = { disposition: "INCOMPLETE", context: null, replacement: null, noncircular: false };
const flows = [
  { id: "initial-exact-limit", input: exact, expected: positive },
  { id: "initial-overflow", input: overflow, expected: incomplete },
  { id: "duplicate-initial-tuples", input: duplicate, expected: { ...positive, originalStates: 1, initialObligations: 3 } },
  { id: "large-shared-domain-row-overflow", input: large, expected: incomplete },
  { id: "translation-exact-limit", input: translationExact, expected: positive },
  { id: "translation-one-row-overflow", input: translationOverflow, expected: incomplete },
];
const forgedId = "rebound-over-budget-positive";
const contract = { schema: "finnor.z5.finite-boundary-contract.v1",
  scope: "DIAGNOSED_PROCESS_BOUNDARIES_NOT_NEW_POPULATION_OR_NATIVE_QUALIFICATION",
  cases: [...flows.map(({ id, input, expected }) => ({ id, inputDigest: digest(input), expected, checkerAccepts: true })),
    { id: forgedId, inputDigest: digest(overflow), expected: "INDEPENDENT_REJECTION_OF_REBOUND_POSITIVE", checkerAccepts: false }],
  expectedValueProvenance: { smallTranslationRows: "2 components * 2 full local tuples * 1 shared valuation = 4",
    largeSharedValuations: "32^8 = 1099511627776, enumerated only until the declared row cap",
    productBound: "Distinct original states count immediately; duplicate tuples retain all initial obligations" } };
await save(path.join(output, "contract.json"), contract);
await save(path.join(output, "inputs.json"), Object.fromEntries(flows.map(({ id, input }) => [id, input])));
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
async function observe(row) { rows.push(row); await save(path.join(output, row.id + ".json"), row); }
let producerExecutions = 0, checkerExecutions = 0, exactCertificate = null;
for (const { id, input, expected } of flows) {
  producerExecutions++;
  const p = await producer(input), certificate = parse(p.stdout);
  let c = null;
  if (certificate) { checkerExecutions++; c = await checker(input, certificate); }
  const check = parse(c?.stdout), positiveResult = expected.disposition === "CHECKED_CANDIDATE";
  const expectedProof = positiveResult
    ? certificate?.original?.states === expected.originalStates
      && certificate?.original?.initial === expected.initialObligations
      && certificate?.translation?.rows === expected.translationRows
    : certificate?.context === null && certificate?.replacement === null && certificate?.discharge?.noncircular === false;
  const passed = p.exitCode === 0 && !p.bounded && certificate?.disposition === expected.disposition
    && expectedProof && c?.exitCode === 0 && !c.bounded && check?.checked === true
    && check?.disposition === expected.disposition;
  await observe({ id, passed, inputDigest: digest(input), expected, producer: p, checker: c });
  if (id === "initial-exact-limit") exactCertificate = certificate;
}
let forgedCheck = null, forged = null;
if (exactCertificate) {
  forged = structuredClone(exactCertificate);
  forged.inputDigest = digest(overflow);
  checkerExecutions++;
  forgedCheck = await checker(overflow, forged);
}
await observe({ id: forgedId, inputDigest: digest(overflow), corruptionDigest: forged && digest(forged),
  expected: "INDEPENDENT_REJECTION_OF_REBOUND_POSITIVE",
  passed: forgedCheck?.exitCode === 1 && !forgedCheck.bounded && parse(forgedCheck.stdout)?.checked === false,
  checker: forgedCheck });
const changedSources = [];
for (const file of sourceFiles)
  if (hash(await readFile(file)) !== source[path.relative(ROOT, file)]) changedSources.push(path.relative(ROOT, file));
const measured = process.cpuUsage(cpu);
const report = { schema: "finnor.z5.finite-boundary-process-e2e.v1",
  state: rows.every(r => r.passed) && changedSources.length === 0 ? "PASSED" : "FAILED",
  source, changedSources, node: process.version, contractDigest: digest(contract),
  cases: rows.map(({ id, passed }) => ({ id, passed })), failures: rows.filter(r => !r.passed).map(r => r.id),
  producerExecutions, checkerExecutions, databaseActions: 0, authActions: 0, listeners: 0,
  nativeProof: "NOT_RUN", structuralFamilyQualification: "NOT_ESTABLISHED", protectedAdmission: false,
  costs: { wallMs: performance.now() - started, parentCpuUserMicros: measured.user,
    parentCpuSystemMicros: measured.system, parentPeakRssBytes: process.resourceUsage().maxRSS * 1024,
    childCpuAndPeakRss: "UNKNOWN_HERE", money: null, human: null, provider: null,
    scope: "PARENT_PROCESS_ONLY_NOT_COMBINED_PEAK_OR_EQUIPPED_RESULT" } };
await save(path.join(output, "report.json"), report);
console.log(JSON.stringify({ output, state: report.state, cases: report.cases.length, failures: report.failures,
  producerExecutions, checkerExecutions }));
process.exitCode = report.state === "PASSED" ? 0 : 1;
