/** Frozen-contract, process-to-process engineering E2E. No DB/auth/listeners. */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { KERNEL, CHECKER, hash, save, evidenceDirectory, producer, checker, fixture } from "./e2e-tools.mjs";
import { digest } from "../../../packages/epistemic-runtime/src/project-z/z5-institution-linker/kernel.ts";
import { assertCurrentScope, assertPhysicalFence } from "../../../packages/epistemic-runtime/src/project-z/z5-institution-linker/ownership.ts";
const output = await evidenceDirectory(process.argv[2]), rows = [], source = {};
for (const file of [KERNEL, CHECKER, new URL(import.meta.url), new URL("./e2e-tools.mjs", import.meta.url),
  new URL("../../../packages/epistemic-runtime/src/project-z/z5-institution-linker/ownership.ts", import.meta.url)])
  source[String(file)] = hash(await readFile(file));
async function observe(id, passed, detail) {
  const row = { id, passed, ...detail }; rows.push(row); await save(path.join(output, id + ".json"), row);
}
const pipeline = await fixture("F01-01"), revised = await fixture("F30-01");
const outputs = {};
for (const [name, f] of [["pipeline", pipeline], ["replacement", revised]]) {
  const p = await producer(f.input); const cert = p.exitCode === 0 ? JSON.parse(p.stdout) : null;
  const c = cert ? await checker(f.input, cert) : null;
  const accepted = c?.exitCode === 0 && JSON.parse(c.stdout).checked === true;
  await observe(name + "-real-process-flow", accepted && cert.disposition === "CHECKED_CANDIDATE"
    && (name !== "replacement" || cert.replacement.status === "BRIDGED"), { producer: p, checker: c,
      fixtureId: f.id, expectedValue: f.expected, nativeProof: false });
  if (!accepted) throw Error("ORIGINAL_PROCESS_FLOW_FAILED");
  outputs[name] = cert;
}
const corruptions = [
  ["drop-original-component-transition", "pipeline", c => { c.context.edges = c.context.edges.filter(e => e.control !== "COMPONENT" || e !== c.context.edges.find(x => x.control === "COMPONENT")); }],
  ["unreachable-assumption-state", "pipeline", c => { const id = "0".repeat(64); c.context.states.push(id); c.context.ranks[id] = 0; }],
  ["erase-original-initial", "pipeline", c => { c.context.initial = []; }],
  ["change-must-availability", "pipeline", c => { const e = c.context.edges.find(x => x.must); if (!e) throw Error("NO_FROZEN_MUST_EDGE"); e.must = false; }],
  ["change-atomic-update", "pipeline", c => { c.context.edges[0].transitions = ["S4:invented-half-update"]; }],
  ["lose-shared-original-identity", "replacement", c => { c.replacement.bridge.carriedCellsDigest = "0".repeat(64); }],
  ["false-nonblocking-rank", "pipeline", c => { c.context.ranks[c.context.initial[0]] = 0; }],
  ["false-simulation-relation", "replacement", c => { c.replacement.relation = []; }],
  ["unreachable-live-clean-reset", "replacement", c => { c.replacement.bridge.old = "0".repeat(64); }],
  ["fabricated-whole-code-correspondence", "pipeline", c => { c.correspondence = "PROVES_ALL_TYPESCRIPT_SQL_AND_PROVIDERS"; }],
  ["false-counterexample-class", "pipeline", c => { c.originalCounterexample.kind = "FINANCIAL_PROFIT_PROVED"; }],
  ["false-exhaustive-translation", "pipeline", c => { c.translation.digest = "0".repeat(64); }],
  ["circular-initial-discharge", "pipeline", c => { c.discharge.noncircular = false; }],
  ["false-maximality", "pipeline", c => { c.context.maximality = "MAXIMAL_CONTEXT"; }],
  ["false-effect-authority", "pipeline", c => { c.executionAuthorityGranted = true; }],
  ["false-protected-admission", "pipeline", c => { c.protectedAdmission = true; }],
];
for (const [id, original, mutate] of corruptions) {
  const cert = structuredClone(outputs[original]); mutate(cert);
  const result = await checker(original === "pipeline" ? pipeline.input : revised.input, cert);
  await observe(id, result.exitCode === 1 && JSON.parse(result.stdout).checked === false,
    { checker: result, corruptionDigest: digest(cert), expected: "INDEPENDENT_REJECTION" });
}
// Actual shared native binding predicate, with SYNTHETIC LOCAL FILE facts,
// not an authentication test or a tenant/owner impersonation.
const binding = { tenant: "offline-tenant", principal: "offline-principal", work: "offline-original-work",
  input: "offline-original-input", root: { type: "OFFLINE_ROOT" }, inputDigest: "input", sourceDigest: "source",
  rightsRevision: "1", liveDigest: "live", ownerCutDigest: "cut", profile: "fixed-profile", mandate: "mandate",
  assignment: "original-assignment", parentReservation: "original-reservation", preparation: "s4-preparation",
  policy: "s4-policy", allocation: "s5-capital", consumption: "s5-use", unresolvedObligations: ["old-callback"],
  originalDeadline: new Date(Date.now() + 60000).toISOString() };
assertCurrentScope(binding, structuredClone(binding));
for (const key of Object.keys(binding)) {
  const changed = { ...binding, [key]: key === "root" ? {} : "CHANGED" };
  let refused = false; try { assertCurrentScope(binding, changed); } catch { refused = true; }
  await observe("scope-" + key, refused, { boundary: "SHARED_NATIVE_PREDICATE_LOCAL_FILE_FACTS_ONLY", expected: "NO_USE" });
}
const physical = { tenant: binding.tenant, token: "owned-current-token", fence: 2, status: "RUNNING", cancelled: false, deadline: Date.now() + 60000 };
assertPhysicalFence(physical, { tenant: binding.tenant, token: physical.token, fence: 2 });
for (const [id, value] of [["old-token", { token: "old" }], ["old-fence", { fence: 1 }], ["wrong-tenant", { tenant: "other" }]]) {
  let refused = false; try { assertPhysicalFence(physical, { tenant: binding.tenant, token: physical.token, fence: 2, ...value }); } catch { refused = true; }
  await observe("physical-" + id, refused, { boundary: "SHARED_NATIVE_FENCE_PREDICATE_LOCAL_FILE_FACTS_ONLY" });
}
const report = { schema: "finnor.z5.process-e2e.v1", state: rows.every(r => r.passed) ? "PASSED" : "FAILED",
  source, cases: rows.map(({ id, passed }) => ({ id, passed })), failures: rows.filter(r => !r.passed).map(r => r.id),
  mathematicalDomain: "EXACT_ORIGINAL_KERNEL", databaseActions: 0, authActions: 0, listeners: 0,
  nativeProof: "NOT_RUN", protectedAdmission: false, financialQualification: false };
await save(path.join(output, "report.json"), report);
console.log(JSON.stringify(report)); process.exitCode = report.state === "PASSED" ? 0 : 1;
