import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DigitalInstitutionProfile } from "./contracts";
import type { InstitutionCandidate, InstitutionCheck, OriginalInstitutionEvidence } from "./checker";

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const root = dirname(fileURLToPath(new URL("../../../../package.json", import.meta.url)));
const command = fileURLToPath(new URL("../../../../scripts/frontier5/x1/checker-command.mts", import.meta.url));
const tsx = join(root, "node_modules/tsx/dist/cli.mjs");
const files = [command, fileURLToPath(new URL("./checker.ts", import.meta.url)),
  fileURLToPath(new URL("./checker-raw.ts", import.meta.url)), tsx, join(root, "package-lock.json")];
// 32 MiB raw can expand through base64 and JSON escaping in the same request
// as an 8 MiB canonical snapshot. This is a transport limit, not a profile cut.
const transportLimit = 384 * 1024 * 1024;

/** A local development process boundary, not protected checker custody or
 * installed-production packaging. Any process, pin or transport fault refuses. */
export function checkInstitutionInSeparateProcess(
  original: OriginalInstitutionEvidence, candidate: InstitutionCandidate, profile: DigitalInstitutionProfile,
): InstitutionCheck {
  const pins = Object.fromEntries(files.map((file) => [file, sha(readFileSync(file))]));
  const input = JSON.stringify({ schema: "finnor.x1.checker-process.v1", pins, original, candidate, profile });
  if (Buffer.byteLength(input) > transportLimit) throw new Error("X1_CHECKER_TRANSPORT_BOUND");
  const result = spawnSync(process.execPath, ["--max-old-space-size=512", tsx, command], {
    cwd: root, encoding: "utf8", input, timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  if (result.error || result.status !== 0 || result.signal) throw new Error("X1_CHECKER_PROCESS_REFUSED");
  let reply: { schema: string; pins: Record<string, string>; inputDigest: string; check: InstitutionCheck };
  try { reply = JSON.parse(result.stdout); } catch { throw new Error("X1_CHECKER_RESPONSE_INVALID"); }
  if (reply.schema !== "finnor.x1.checker-process.v1" || JSON.stringify(reply.pins) !== JSON.stringify(pins)
      || reply.inputDigest !== sha(input)
      || !reply.check || !["REJECTED", "ACCEPTED_DEVELOPMENT"].includes(reply.check.disposition)
      || (reply.check.disposition === "ACCEPTED_DEVELOPMENT"
        && (reply.check.inputDigest !== sha(JSON.stringify(original))
          || reply.check.candidateDigest !== sha(JSON.stringify(candidate))
          || reply.check.profileDigest !== sha(JSON.stringify(profile))
          || reply.check.checkerRevision !== original.current.checkerRevision))) {
    throw new Error("X1_CHECKER_PIN_OR_RESULT_MISMATCH");
  }
  return reply.check;
}
