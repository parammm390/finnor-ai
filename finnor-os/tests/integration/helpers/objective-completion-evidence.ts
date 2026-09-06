import type { ObjectiveDecision, ObjectiveInspection } from "@finnor/orchestration";

/** Existing Objective Loop journey tests predate the Phase 3 requirement that a
 * planner cite exact evidence when it requests completion. Preserve the journeys,
 * but make their scripted planners obey the production completion contract. */
export function citeObservedObjectiveEvidence(
  decision: ObjectiveDecision,
  inspection: ObjectiveInspection,
): ObjectiveDecision {
  if (decision.kind !== "complete" || decision.evidence?.length) return decision;
  const evidence: NonNullable<Extract<ObjectiveDecision, { kind: "complete" }>["evidence"]> = [];
  const effects = inspection.businessEffects as Array<{ id?: string; status?: string }>;
  for (const effect of effects.filter((row) => row.status === "verified" && typeof row.id === "string")) {
    evidence.push({ kind: "business_effect", businessEffectId: effect.id! });
  }
  const wake = inspection.eventWake as { event?: { id?: string } } | null;
  if (wake?.event?.id) evidence.push({ kind: "matched_event", integrationEventId: wake.event.id });
  const delegation = (inspection.delegations as Array<{ id?: string; status?: string }>).find((row) => row.id && ["acknowledged", "accepted", "completed"].includes(String(row.status)));
  if (delegation?.id) evidence.push({
    kind: "delegation",
    delegationId: delegation.id,
    requiredStatus: delegation.status === "completed" ? "completed" : delegation.status === "accepted" ? "accepted" : "acknowledged",
  });
  const computerRun = (inspection.computerRuns as Array<{ id?: string; status?: string; evidence?: unknown[] }>).find((row) => row.id && row.status === "succeeded");
  if (computerRun?.id) evidence.push({ kind: "computer_run", computerRunId: computerRun.id, evidenceRequired: Boolean(computerRun.evidence?.length) });
  // A fresh Operational Query assertion is always included as an independent,
  // deterministic fallback. It asserts a real canonical aggregate field rather
  // than trusting the scripted planner's prose or outcome object.
  evidence.push({
    kind: "canonical_query",
    request: { intent: "work_list", openOnly: true },
    assertion: { path: ["rows"], operator: "exists" },
  });
  return { ...decision, evidence };
}
