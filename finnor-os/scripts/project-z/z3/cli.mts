import { createInterface } from "node:readline";
import { produceViability } from "../../../packages/epistemic-runtime/src/project-z/z3-viability/producer";
import { PROFILE, Z3_VERSION, type IncompleteCandidate, type SolverLimits } from "../../../packages/epistemic-runtime/src/project-z/z3-viability/contracts";

if (process.argv[2] !== "produce-batch") throw Error("Expected produce-batch with bounded NDJSON original inputs");
const unsupported = (reason: string): string => JSON.stringify({
  schema: "finnor.z3.viability-candidate.v1", version: Z3_VERSION, disposition: "UNSUPPORTED",
  arenaDigest: null, bindingDigest: null, reason, certificate: null, strategy: null,
  metrics: { wallMs: 0, operations: 0 },
} satisfies IncompleteCandidate);
let count = 0;
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  // One output row per input row: a malformed record fails closed in place and
  // never aborts the remaining batch or shifts the caller's index alignment.
  if (++count > 8192) throw Error("Z3_FINITE_CLI_INPUT_BOUND");
  if (Buffer.byteLength(line) > PROFILE.inputBytes) { process.stdout.write(unsupported("Z3_FINITE_CLI_INPUT_BOUND") + "\n"); continue; }
  let request: { arena?: unknown; binding?: unknown; limits?: SolverLimits };
  try { request = JSON.parse(line); } catch { process.stdout.write(unsupported("Z3_CLI_MALFORMED_NDJSON") + "\n"); continue; }
  process.stdout.write(JSON.stringify(produceViability(request?.arena, request?.binding, request?.limits ?? {})) + "\n");
}
