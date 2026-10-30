/** Five alternating producer/checker diagnostics, not equipped speedup trials. */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { ROOT, KERNEL, CHECKER, evidenceDirectory, save, hash, fixture, producer, checker } from "./e2e-tools.mjs";
const output = await evidenceDirectory(process.argv[2]), rows = [], code = {};
for (const file of [KERNEL, CHECKER, new URL(import.meta.url), new URL("./e2e-tools.mjs", import.meta.url)])
  code[String(file)] = hash(await readFile(file));
const original = await fixture("F30-01");
for (let repetition = 1; repetition <= 5; repetition++) {
  const p = await producer(original.input);
  await save(path.join(output, `A-${repetition}.json`), p);
  if (p.exitCode !== 0 || p.bounded) throw Error("BOUNDED_ORIGINAL_PRODUCER_DIAGNOSTIC_FAILED");
  const certificate = JSON.parse(p.stdout);
  const c = await checker(original.input, certificate);
  await save(path.join(output, `B-${repetition}.json`), c);
  const checked = c.exitCode === 0 ? JSON.parse(c.stdout) : null;
  if (!checked?.checked || certificate.disposition !== original.expected.disposition
    || certificate.replacement?.status !== original.expected.replacement)
    throw Error("INDEPENDENT_ORIGINAL_DIAGNOSTIC_FAILED");
  rows.push({ repetition, order: ["A_PRODUCE", "B_INDEPENDENT_ORIGINAL_CHECK"],
    fixtureId: original.id, producerExit: p.exitCode, checkerExit: c.exitCode,
    producerWallIncludingStartupMs: p.wallMs, checkerWallIncludingStartupMs: c.wallMs,
    producer: certificate.costs, checkerOperations: checked.operations,
    original: certificate.original, contextStates: certificate.context.states.length,
    contextEdges: certificate.context.edges.length, translationRows: certificate.translation.rows,
    relationPairs: certificate.replacement.relation.length, certificateBytes: Buffer.byteLength(p.stdout),
    liveBridge: certificate.replacement.bridge, sourceInputDigest: checked.inputDigest });
}
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted.at(-1) };
};
const report = { schema: "finnor.z5.alternating-public-diagnostics.v1", state: "PASSED",
  sourceFiles: code, fixtureId: original.id, fixtureInputSha256: hash(JSON.stringify(original.input)),
  repetitions: 5, rows,
  summary: {
    producerWallIncludingStartupMs: summary(rows.map(r => r.producerWallIncludingStartupMs)),
    checkerWallIncludingStartupMs: summary(rows.map(r => r.checkerWallIncludingStartupMs)),
    completeProcessPipelineWallMs: summary(rows.map(r => r.producerWallIncludingStartupMs + r.checkerWallIncludingStartupMs)),
    certificateBytes: summary(rows.map(r => r.certificateBytes)),
    producerPeakRssBytes: summary(rows.map(r => r.producer.peakRssBytes)) },
  comparison: { state: "NOT_RUN", qualifiedCompletedXYRelease: null,
    credited: ["FULL_INTENDED_XY", "X2_COMPOSITION", "X3_INSTALLED_INVARIANTS", "Y5_CHECKED_CORRESPONDENCE",
      "ORDINARY_MODEL_CHECKING", "PACTI_OCRA_COMPATIBLE_COMPOSITION", "EQUIPPED_LINKING"],
    reason: "A and B perform different complementary roles. Their times are not a speedup ratio or an equipped comparison.",
    novelIncrement: "UNESTABLISHED", compactness: "FULL_ORIGINAL_PRODUCT_EXPLORED_NO_COMPACTNESS_CLAIM" },
  costs: { database: "NOT_RUN", originalOwnerExtraction: null, integration: null, invalidation: null,
    nativeReplacement: null, nativeRecovery: null, install: null, money: null, human: null,
    gaps: ["CHECKER_CPU_RSS_NOT_METERED", "NATIVE_OWNER_EXTRACTION_NOT_RUN", "COMPLETE_SHARED_INTEGRATION_NOT_RUN",
      "INSTALLED_APPLICATION_NOT_RUN", "MODEL_AND_HUMAN_COST_NOT_METERED", "FAILED_ATTEMPTS_RETAINED_SEPARATELY"] },
  protectedAdmission: false, operational100x: "NOT_RUN", financial100x: "NOT_RUN",
  databaseActions: 0, listenersStarted: 0, sourceRepository: ROOT };
await save(path.join(output, "report.json"), report);
console.log(JSON.stringify({ state: report.state, repetitions: 5, summary: report.summary, equippedComparison: "NOT_RUN" }));
