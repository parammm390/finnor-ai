export const participantControlName = "participant-deal-denial";

export function participantDealDenied(attempt: Record<string, unknown> | undefined): boolean {
  if (!attempt || attempt.stage !== "T0") return false;
  const intake = attempt.intake as { status?: number; body?: { error?: string } } | undefined;
  return intake?.status === 403
    && intake.body?.error === "The business root or selected subject is unavailable in the current scope"
    && attempt.loop == null
    && [attempt.jobs, attempt.actions, attempt.effects].every(rows => Array.isArray(rows) && rows.length === 0);
}
