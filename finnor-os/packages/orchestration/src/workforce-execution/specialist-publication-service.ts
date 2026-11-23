/** Independently enrolled original-only consumer of durable candidate/upper
 * rows. This service has no candidate, model, budget or role-switching port. */
import { setTimeout as delay } from "node:timers/promises";
import type { CanonicalSpecialistAuthority } from "../../../capability-evolution/src/specialist-publication-authority";
import { fault } from "../../../capability-evolution/src/contracts";
import { proveOriginalSpecialistPublication, projectOriginalSpecialistPublication } from "./specialist-publication";

type Status = "ORIGINAL_DECISION_RECORDED" | "ORIGINAL_DECISION_ALREADY_RECORDED"
  | "APPLIED_ORIGINAL_HISTORY" | "CONFLICT_HISTORY_RETAINED" | "UNKNOWN_READ_ONLY";
export interface OriginalPublicationServiceStatus {
  publicationId: string; status: Status; errorCode: string | null;
}
const statuses = new Set<Status>(["ORIGINAL_DECISION_RECORDED", "ORIGINAL_DECISION_ALREADY_RECORDED",
  "APPLIED_ORIGINAL_HISTORY", "CONFLICT_HISTORY_RETAINED", "UNKNOWN_READ_ONLY"]);
const safeErrorCode = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9]{5}$/.test(code) ? code : "ORIGINAL_READBACK_OR_PROOF_UNAVAILABLE";
};

export async function runIndependentOriginalPublicationService(input: {
  authority: CanonicalSpecialistAuthority; signal: AbortSignal;
  maximumWallMs: number; pollIntervalMs: number; maximumAttempts: number; batchSize: number;
  onStatus(status: Readonly<OriginalPublicationServiceStatus>): void;
}) {
  const { authority } = input;
  if (authority.config.role !== "proof" && authority.config.role !== "projection")
    fault("SPECIALIST_INDEPENDENT_ORIGINAL_SERVICE_REQUIRED", 403);
  if (!Number.isSafeInteger(input.maximumWallMs) || input.maximumWallMs < 1000 || input.maximumWallMs > 300000
    || !Number.isSafeInteger(input.pollIntervalMs) || input.pollIntervalMs < 250 || input.pollIntervalMs > 5000
    || !Number.isSafeInteger(input.maximumAttempts) || input.maximumAttempts < 1 || input.maximumAttempts > 1024
    || !Number.isSafeInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 64)
    fault("SPECIALIST_ORIGINAL_SERVICE_BOUND_REQUIRED", 400);
  // This bounds accepting service work, not any original invocation lifetime.
  // At stop, drain at most the current bounded historical operation.
  const deadline = performance.now() + input.maximumWallMs;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.maximumWallMs)]);
  let afterId = "", attempts = 0, scans = 0, failedScans = 0;
  while (!signal.aborted && performance.now() < deadline && attempts < input.maximumAttempts) {
    let ids: readonly string[];
    try {
      ids = await authority.listOriginalPublications(afterId, Math.min(input.batchSize, input.maximumAttempts - attempts));
      scans++;
    } catch {
      // No alternate role, fresh candidate or new identity repairs a failed scan.
      failedScans++;
      ids = [];
    }
    if (!ids.length) afterId = "";
    for (const publicationId of ids) {
      if (signal.aborted || performance.now() >= deadline || attempts >= input.maximumAttempts) break;
      attempts++; afterId = publicationId;
      let status: Status = "UNKNOWN_READ_ONLY", errorCode: string | null = null;
      try {
        const result = authority.config.role === "proof"
          ? await proveOriginalSpecialistPublication(authority, publicationId)
          : await projectOriginalSpecialistPublication(authority, publicationId);
        const value = typeof result === "string" ? result : result?.status;
        if (!statuses.has(value as Status)) fault("SPECIALIST_ORIGINAL_SERVICE_STATUS_INVALID", 503);
        status = value as Status;
      } catch (error) { errorCode = safeErrorCode(error); }
      input.onStatus(Object.freeze({ publicationId, status, errorCode }));
    }
    if (signal.aborted || performance.now() >= deadline || attempts >= input.maximumAttempts) break;
    try { await delay(Math.min(input.pollIntervalMs, Math.max(1, deadline - performance.now())), undefined, { signal }); }
    catch (error) { if (!signal.aborted) throw error; }
  }
  return Object.freeze({ schema: "finnor.w2.original-publication-service-run.v1",
    role: authority.config.role, attempts, scans, failedScans,
    status: input.signal.aborted ? "STOPPED" : attempts >= input.maximumAttempts ? "ATTEMPT_BOUND_REACHED" : "SERVICE_WALL_REACHED",
    originalOnly: true, physicalReplayPermitted: false, budgetRenewed: false });
}
