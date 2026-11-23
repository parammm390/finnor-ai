/** Owning E2E observes actual objects only. It cannot issue a healthy source. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Socket } from "node:net";
import type { JobExecutionContext } from "../../../apps/worker/src/queue";
import type { CanonicalSpecialistAuthority } from "../../capability-evolution/src/specialist-publication-authority";
import type { SourceRegistration, OriginCensus } from "./specialist-origin-contract";
import type { OriginalP3Source } from "./specialist-origin-context";
import type { ActualOriginalFailureEvidence } from "./specialist-origin-failure";

export const originalOriginOwningPhases = [
  "SOURCE_READY", "BEFORE_SOURCE_CENSUS", "AFTER_SOURCE_CENSUS",
  "BEFORE_ORIGINAL_FINALIZE", "AFTER_ORIGINAL_FINALIZE",
] as const;
export type OriginalOriginOwningPhase = typeof originalOriginOwningPhases[number];
export type ActualOriginalOriginOwningView = Readonly<{
  registration: SourceRegistration; execution: Readonly<JobExecutionContext>;
  p3: OriginalP3Source; controller: AbortController; combined: AbortSignal; originalSignal: AbortSignal;
  authority: CanonicalSpecialistAuthority; sourceSocket: Socket; lastCensus: OriginCensus | null;
  drainNegativeRecords(): Promise<void>;
  readActualFailureEvidence(): Promise<ActualOriginalFailureEvidence>;
}>;
export type OriginalOriginOwningObserver = (
  phase: OriginalOriginOwningPhase, actual: ActualOriginalOriginOwningView,
) => Promise<void>;
const owning = new AsyncLocalStorage<OriginalOriginOwningObserver>();
/** The genuine worker fixture wraps its REAL queued handler, not a substitute. */
export function withOriginalOriginOwningFixture<T>(observer: OriginalOriginOwningObserver, run: () => Promise<T>) {
  return owning.run(observer, run);
}
/** No observer installed in an ordinary/production caller means exactly no-op. */
export async function visitOriginalOriginOwningFixture(
  phase: OriginalOriginOwningPhase, actual: () => ActualOriginalOriginOwningView,
) {
  const observer = owning.getStore(); if (observer) await observer(phase, actual());
}
