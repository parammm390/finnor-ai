/** Local fresh-process replay over an already authorized captured S1 view.
 * No acquisition, database, protected admission or new provider observation. */
import { readFile } from "node:fs/promises";
import { designExperiments } from "@finnor/epistemic-runtime";
const input = JSON.parse(await readFile(process.argv[2]!, "utf8"));
const bundle = designExperiments(input);
console.log(JSON.stringify({ compute: bundle.compute, resultRefs: bundle.designs.map(d => d.protocol?.id ?? null),
  resultBytes: Buffer.byteLength(JSON.stringify(bundle)), processResourceUsage: process.resourceUsage(), boundary: "Captured permitted S1 view; fresh local process; no new read/measurement/admission" }));
