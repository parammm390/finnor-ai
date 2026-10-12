import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { independentlyCheckInstitutionModel, type InstitutionCandidate, type OriginalInstitutionEvidence } from "../../../packages/private-equity/src/institution-program/checker";
import type { DigitalInstitutionProfile } from "../../../packages/private-equity/src/institution-program/contracts";
import { installedDevelopmentRuntime } from "../../../packages/private-equity/src/institution-program/installed-runtime";

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const files = [fileURLToPath(import.meta.url),
  fileURLToPath(new URL("../../../packages/private-equity/src/institution-program/checker.ts", import.meta.url)),
  fileURLToPath(new URL("../../../packages/private-equity/src/institution-program/checker-raw.ts", import.meta.url)),
  fileURLToPath(new URL("../../../packages/private-equity/src/institution-program/canonical-json.ts", import.meta.url)),
  fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
  fileURLToPath(new URL("../../../package-lock.json", import.meta.url))];
const installation = installedDevelopmentRuntime();
if(installation&&(process.env.NODE_ENV==='production'||process.env.FINNOR_ENVIRONMENT==='production'
    ||process.env.FINNOR_P4_PROFILE!=='ordinary_disposable'))throw Error('X1_COMPILED_DEVELOPMENT_PROFILE_REQUIRED');
const pins = installation ? installation.checkerPins() : Object.fromEntries(files.map((file) => [file, sha(readFileSync(file))]));
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 384 * 1024 * 1024) throw new Error("X1_CHECKER_TRANSPORT_BOUND");
}
const request = JSON.parse(input) as {
  schema: string; pins: Record<string, string>;
  original: OriginalInstitutionEvidence; candidate: InstitutionCandidate; profile: DigitalInstitutionProfile;
};
if (request.schema !== "finnor.x1.checker-process.v1"
  || JSON.stringify(request.pins) !== JSON.stringify(pins)) throw new Error("X1_CHECKER_CODE_PIN_MISMATCH");
const check = await independentlyCheckInstitutionModel(request.original, request.candidate, request.profile);
process.stdout.write(JSON.stringify({ schema: request.schema, pins, inputDigest: sha(input), check }));
