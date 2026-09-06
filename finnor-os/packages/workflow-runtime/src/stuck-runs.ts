// Shared definition of a watchdog-stuck workflow run. The worker scan and the
// read-only run browser must use the exact same threshold; duplicating those values
// would let the UI claim a run was healthy when the watchdog has already flagged it.

export const STUCK_RUN_DEADLINE_HOURS: Readonly<Record<string, number>> = {
  single_action: 0.25,
};

export const DEFAULT_STUCK_RUN_DEADLINE_HOURS = 24;

export function stuckRunDeadlineHours(workflowType: string): number {
  return STUCK_RUN_DEADLINE_HOURS[workflowType] ?? DEFAULT_STUCK_RUN_DEADLINE_HOURS;
}

export function isRunPastWatchdogDeadline(
  run: { workflowType: string; updatedAt: Date },
  now = new Date(),
): boolean {
  return now.getTime() - run.updatedAt.getTime() >= stuckRunDeadlineHours(run.workflowType) * 3_600_000;
}
