export interface HeartbeatLease {
  leaseSeconds: number;
}

function renewalInterval(leaseSeconds: number): number {
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) throw new Error("Heartbeat lease lifetime must be positive and finite");
  return Math.max(1, Math.floor(leaseSeconds * 1000 / 3));
}

/** One serialized renewal loop for the physical job and its owned claims. */
export function startJobHeartbeat(input: HeartbeatLease & {
  renew: () => Promise<boolean>;
  onError: (error: unknown) => void;
}) {
  const jobInterval = renewalInterval(input.leaseSeconds);
  const physicalScope = new AsyncResource("finnor.job-heartbeat", { requireManualDestroy: true });
  const registrations = new Set<{ callback: () => Promise<boolean>; interval: number; dueAt: number }>();
  let jobDueAt = performance.now() + jobInterval;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | null = null;
  let stopped = false, lost = false;
  const leaseLoss = new AbortController();
  const markLost = () => {
    lost = true;
    if (!leaseLoss.signal.aborted) leaseLoss.abort(new Error("Worker lost a durable job or owned claim lease"));
  };

  const schedule = () => {
    clearTimeout(timer);
    if (stopped || lost || pending) return;
    const dueAt = Math.min(jobDueAt, ...[...registrations].map(registration => registration.dueAt));
    // Registrations can arrive inside an owner's shorter database deadline.
    // Physical ownership must keep renewing after that scope closes normally.
    physicalScope.runInAsyncScope(() => {
      timer = setTimeout(() => {
        pending = renew().finally(() => { pending = null; schedule(); });
      }, Math.max(0, dueAt - performance.now()));
    });
  };
  const renew = async () => {
    try {
      if (!await input.renew()) { markLost(); return; }
      jobDueAt = performance.now() + jobInterval;
      await Promise.all([...registrations].map(async registration => {
        if (!registrations.has(registration) || registration.dueAt > performance.now()) return;
        let owned = false;
        try { owned = await registration.callback(); }
        catch (error) {
          if (registrations.has(registration)) markLost();
          input.onError(error);
        }
        if (!owned && registrations.has(registration)) markLost();
        registration.dueAt = performance.now() + registration.interval;
      }));
    } catch (error) { markLost(); input.onError(error); }
  };
  schedule();
  return {
    get lost() { return lost; },
    leaseLossSignal: leaseLoss.signal,
    async sourceBarrier(): Promise<void> {
      const originalPending = pending;
      if (originalPending) await originalPending;
      if (stopped || lost || leaseLoss.signal.aborted)
        throw new Error("SPECIALIST_ORIGIN_ACTUAL_JOB_SOURCE_ENDED");
    },
    // A guard of this physical job inherits its real lifetime. Independent
    // resources must supply their own lease so shorter reservations renew in time.
    register(callback: () => Promise<boolean>, lease: HeartbeatLease = input): () => void {
      if (stopped || lost) throw new Error("Cannot register a claim after job lease ownership ended");
      const interval = renewalInterval(lease.leaseSeconds);
      const registration = { callback, interval, dueAt: performance.now() + interval };
      registrations.add(registration);
      schedule();
      return () => { registrations.delete(registration); schedule(); };
    },
    async stop(): Promise<void> {
      if (stopped) { await pending; return; }
      stopped = true;
      clearTimeout(timer);
      registrations.clear();
      try { await pending; } finally { physicalScope.emitDestroy(); }
    },
  };
}

import { AsyncResource } from "node:async_hooks";
