import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { superviseParticipantAuthority } from "./participant-authority-supervisor.mts";

const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === "--output" && args[1]!.startsWith("/"), "NEW_ABSOLUTE_OUTPUT_REQUIRED");
const report = await superviseParticipantAuthority({
  root: fileURLToPath(new URL("../../../", import.meta.url)),
  body: fileURLToPath(new URL("./participant-authority-body.mts", import.meta.url)),
  output: args[1]!,
});
console.log(JSON.stringify({ status: report.status, cases: report.cases?.length ?? 0,
  supervision: report.supervision, artifact: report.supervision.artifactWritten ? args[1] + "/receipt.json" : null }));
process.exit(report.status === "PASS" ? 0 : 1);
