/** Each invocation uses ONE independently enrolled OS/SQL role. No role switching,
 * grants, candidate retry or model invocation is available from this entrypoint. */
import { openWorkforceSpecialistPublicationAuthority } from "../../packages/capability-evolution/src/specialist-consumer";
import { proveOriginalSpecialistPublication, projectOriginalSpecialistPublication } from "../../packages/orchestration/src/workforce-execution/specialist-publication";
import { runIndependentOriginalPublicationService } from "../../packages/orchestration/src/workforce-execution/specialist-publication-service";
const [operation, publicationId] = process.argv.slice(2);
const serve = operation === "serve-proof" || operation === "serve-projection";
if (serve ? process.argv.length !== 3
  : process.argv.length !== 4 || !["prove-original", "project-original", "observe-original"].includes(operation ?? "")
    || !/^[a-f0-9]{64}$/.test(publicationId ?? "")) throw new Error("SPECIALIST_ORIGINAL_SERVICE_ARGUMENTS");
const authority = await openWorkforceSpecialistPublicationAuthority(
  operation === "prove-original" || operation === "serve-proof" ? "proof"
    : operation === "project-original" || operation === "serve-projection" ? "projection" : "reader");
try {
  if (serve) {
    const stop = new AbortController(), stopped = () => stop.abort(Error("SPECIALIST_ORIGINAL_SERVICE_STOPPED"));
    process.once("SIGTERM", stopped); process.once("SIGINT", stopped);
    try {
      const result = await runIndependentOriginalPublicationService({ authority, signal: stop.signal,
        maximumWallMs: 300000, pollIntervalMs: 1000, maximumAttempts: 1024, batchSize: 32,
        onStatus: status => console.log(JSON.stringify({ operation, ...status })) });
      console.log(JSON.stringify(result));
    } finally { process.removeListener("SIGTERM", stopped); process.removeListener("SIGINT", stopped); }
  } else {
    const result = operation === "prove-original" ? await proveOriginalSpecialistPublication(authority, publicationId!)
      : operation === "project-original" ? await projectOriginalSpecialistPublication(authority, publicationId!)
      : await authority.observeOriginal(publicationId!);
    // Never log native inputs, output, principal IDs, credentials or witness content.
    console.log(JSON.stringify({ operation, publicationId, status:
      typeof result === "string" ? result : result?.status ?? (result?.decision ? "ORIGINAL_DECIDED" : "UNKNOWN_READ_ONLY") }));
  }
} finally { await authority.close(); }
