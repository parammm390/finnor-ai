/** Offline original-derived graph check. It does not authenticate new originals,
 * establish current owner authority, admit a method or observe physical service. */
import { strict as assert } from "node:assert";
import { readFile, writeFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { createRequire } from "node:module";
import { OutcomeContractSchema, ProviderEvidenceSchema, SourceRefSchema, W3_BOUNDS } from "../../../packages/private-equity/src/real-world-service/contracts";
import { checkServiceProgram } from "../../../packages/private-equity/src/real-world-service/checker";
import { serviceIdentity } from "../../../packages/private-equity/src/real-world-service/identity";

const [input, output] = process.argv.slice(2);
createRequire(import.meta.url)("@finnor/source-custody/installation.cjs").installedRuntime(true);
assert(input && output && isAbsolute(input) && isAbsolute(output), "W3_ABSOLUTE_CHECK_INPUT_AND_NEW_OUTPUT_REQUIRED");
assert((await stat(input)).size <= W3_BOUNDS.artifactBytes, "W3_CHECK_INPUT_BYTE_BOUND");
const body = JSON.parse(await readFile(input, "utf8"));
const original = OutcomeContractSchema.parse(body.original);
const providers = z.array(z.object({
  ref: SourceRefSchema, body: ProviderEvidenceSchema, authorId: z.string().uuid(),
  classification: z.enum(["CONTROLLED", "REPLAYED"]),
  current: z.boolean(), invalidationReasons: z.array(z.string().min(1).max(160)).max(32),
}).strict()).max(W3_BOUNDS.providers).parse(body.providers);
const check = checkServiceProgram(original, providers, body.candidate, await serviceIdentity(), Date.now());
await writeFile(resolve(output), JSON.stringify({
  schema: "finnor.w3.offline-check.v1", check,
  originalAuthenticationEstablished: false, currentOwnerAuthorityEstablished: false,
  physicalDeliveryEstablished: false, protectedQualification: false, productionActive: false,
}, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ disposition: check.disposition, output }));
process.exitCode = check.disposition === "CHECKED_DEVELOPMENT" ? 0 : 1;
