import type { CoalitionProblem,CoalitionCandidate } from "../../../shared-types/src/coalition-programme";
import type {ExperimentRef} from "../../../shared-types/src/experiments";
import { constructCoalitionFamily } from "./programmes";
import {compileSelectedCoalitionProgramme} from "./selected-programme";

const chunks: Buffer[] = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 8388608) throw Error("R5_ORIGINAL_INPUT_BYTE_CAP");
  chunks.push(chunk);
}
const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
  histories: Array<{ original: CoalitionProblem; deadlineAt: number;candidate?:CoalitionCandidate;selectionRef?:ExperimentRef }>;
};
if (request.histories.length !== 1) throw Error("R5_ONE_ORIGINAL_COMPILATION_REQUIRED");
const { original, deadlineAt,candidate,selectionRef } = request.histories[0]!;
const checkpoint=() => {
  if (Date.now() >= deadlineAt) throw Error("R5_ORIGINAL_DEADLINE_EXHAUSTED");
};
checkpoint();
const output=candidate&&selectionRef?compileSelectedCoalitionProgramme(original,candidate,selectionRef):
 constructCoalitionFamily(original,checkpoint);
checkpoint();
process.stdout.write(JSON.stringify(output));
