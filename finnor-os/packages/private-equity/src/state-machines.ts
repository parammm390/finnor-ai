import type { PeLifecycleName, PeLifecycleState } from "./types";

export const PE_TRANSITIONS: Readonly<Record<PeLifecycleName, Readonly<Record<string, readonly string[]>>>> = {
  deal: { active: ["closed", "terminated"], closed: [], terminated: [] },
  deal_party: { active: ["removed"], removed: [] },
  workstream: { not_started: ["active", "cancelled"], active: ["complete", "cancelled"], complete: [], cancelled: [] },
  request: { open: ["acknowledged", "fulfilled", "cancelled"], acknowledged: ["fulfilled", "cancelled"], fulfilled: [], cancelled: [] },
  deliverable: {
    expected: ["received", "superseded", "cancelled"],
    received: ["accepted", "rejected", "superseded", "cancelled"],
    rejected: ["received", "superseded", "cancelled"],
    accepted: ["superseded"],
    superseded: [],
    cancelled: [],
  },
  finding: { open: ["resolved", "accepted", "superseded"], resolved: ["superseded"], accepted: ["superseded"], superseded: [] },
  deal_risk: { open: ["mitigating", "resolved", "accepted"], mitigating: ["resolved", "accepted"], resolved: [], accepted: [] },
  milestone: { pending: ["achieved", "cancelled"], achieved: [], cancelled: [] },
  closing_condition: { open: ["evidence_pending", "satisfied", "waived", "failed"], evidence_pending: ["satisfied", "waived", "failed"], satisfied: [], waived: [], failed: [] },
  closing_item: { open: ["ready", "cancelled"], ready: ["verified", "cancelled"], verified: [], cancelled: [] },
};

export function transitionAllowed(lifecycle: PeLifecycleName, from: string, to: string): boolean {
  return PE_TRANSITIONS[lifecycle][from]?.includes(to) ?? false;
}

export function assertTransition(lifecycle: PeLifecycleName, from: string, to: string): void {
  if (!transitionAllowed(lifecycle, from, to)) {
    throw new Error(`invalid ${lifecycle} transition ${from} -> ${to}`);
  }
}

export function isRequestOverdue(request: { state: string; dueAt?: Date | string | null }, now = new Date()): boolean {
  if (!request.dueAt || request.state === "fulfilled" || request.state === "cancelled") return false;
  const due = request.dueAt instanceof Date ? request.dueAt : new Date(request.dueAt);
  return !Number.isNaN(due.getTime()) && due.getTime() < now.getTime();
}

export function isMilestoneLate(milestone: { state: string; targetAt: Date | string }, now = new Date()): boolean {
  if (milestone.state !== "pending") return false;
  const target = milestone.targetAt instanceof Date ? milestone.targetAt : new Date(milestone.targetAt);
  return !Number.isNaN(target.getTime()) && target.getTime() < now.getTime();
}

export function isPositiveDependencyResolution(entityType: string, state: PeLifecycleState | string): boolean {
  switch (entityType) {
    case "pe_workstream": return state === "complete" || state === "cancelled";
    case "pe_request": return state === "fulfilled" || state === "cancelled";
    case "pe_deliverable": return state === "accepted" || state === "superseded" || state === "cancelled";
    case "pe_finding": return state === "resolved" || state === "accepted" || state === "superseded";
    case "pe_deal_risk": return state === "resolved" || state === "accepted";
    case "pe_milestone": return state === "achieved" || state === "cancelled";
    case "pe_closing_condition": return state === "satisfied" || state === "waived";
    case "pe_closing_item": return state === "verified" || state === "cancelled";
    default: return false;
  }
}
