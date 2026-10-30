/**
 * Builds `finnor.project-z.z0-native-session.v2` for one finished native Z0 run from the evidence directory the
 * scenario already wrote. It adds nothing that the run did not observe: cases, outcomes, reasons, evidence digests,
 * the run command, exit code and the meter receipt when the run recorded one.
 *
 * usage: node z0-artifact.mjs RUN_NAME MODE HEAD EXIT_CODE [OUT_ROOT=/home/factory-user/repos/fzv-int-out]
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [run, mode, head, exitCode, outRoot = "/home/factory-user/repos/fzv-int-out"] = process.argv.slice(2);
if (!run || !mode || !head || exitCode === undefined) throw Error("usage: z0-artifact.mjs RUN_NAME MODE HEAD EXIT_CODE [OUT_ROOT]");
const dir = join(outRoot, "native", run, "scenario-01");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const files = readdirSync(dir).filter(name => /^z0-\d+-.*\.json$/.test(name)).sort();
const read = name => { const bytes = readFileSync(join(dir, name)); return { bytes, json: JSON.parse(bytes.toString("utf8")) }; };
const summaryName = files.find(name => /-summary\.json$/.test(name));
if (!summaryName) throw Error("Z0_ARTIFACT_NO_SUMMARY_IN_" + dir);
const summary = read(summaryName);
const caseFiles = files.filter(name => /-case-/.test(name));
const cases = caseFiles.map(name => {
  const { bytes, json } = read(name);
  return {
    id: json.id, title: json.title, outcome: json.outcome, startedAt: json.started ?? null,
    reason: json.reason ?? json.detail?.reason ?? null, error: json.error ?? null,
    predicate: json.detail?.predicate ?? json.detail?.matchedPredicate ?? null,
    expected: json.detail?.expectedPredicates ?? null,
    evidence: { file: name, sha256: sha(bytes) },
  };
});
const meter = files.filter(name => /meter-receipt/.test(name)).map(name => { const { bytes, json } = read(name); return { file: name, sha256: sha(bytes), schema: json.schema ?? null, receipt: json }; });
const tally = cases.reduce((acc, row) => ({ ...acc, [row.outcome]: (acc[row.outcome] ?? 0) + 1 }), {});
const flags = { default: "", kill: "FINNOR_Z0_MODE=kill ", revoke: "FINNOR_Z0_MODE=revoke ", reject: "FINNOR_Z0_MODE=reject ", current: "FINNOR_Z0_MODE=current ", boundaries: "FINNOR_Z0_MODE=boundaries " };
const artifact = {
  schema: "finnor.project-z.z0-native-session.v2",
  run, mode, head, exitCode: Number(exitCode), evidenceDirectory: dir,
  inputs: {
    scenario: "finnor-os/scripts/project-z/native/z0-session.mjs", profile: "z0", launcher: "native-run.sh --no-worker",
    owner: "disposable tenant owner, authenticated HTTP; fixture rows only through owner code (x1-origin-fixture.mts)",
    failureModel: "scope-z/phase-evidence/z0/native-original-parent-failure-model.md",
  },
  rerun: `${flags[mode] ? "/usr/bin/env " + flags[mode] : ""}/home/factory-user/repos/fzv-int-out/native-run.sh NAME z0 finnor-os/scripts/project-z/native/z0-session.mjs --no-worker${flags[mode] ? " --forward-env=FINNOR_Z0_MODE" : ""}`,
  tally, cases,
  skips: cases.filter(row => row.outcome === "NOT_RUN").map(row => ({ id: row.id, reason: row.reason })),
  costs: meter.length ? meter : "no meter receipt recorded in this mode run",
  summary: { file: summaryName, sha256: sha(summary.bytes) },
  observedBy: "z0-session.mjs (database and authenticated HTTP read-backs inside each case file); expected values and their provenance are the predicates named per case and the failure model",
};
const out = join(dir, "z0-native-session-v2.json");
const text = JSON.stringify(artifact, null, 2) + "\n";
writeFileSync(out, text, { mode: 0o600 });
console.log(JSON.stringify({ artifact: out, sha256: sha(text), tally }));
