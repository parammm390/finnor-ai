# Successor-2 campaign failure model (delta)

Inherits `campaign-successor/failure-model.md` in full. Additions learned from
successor-1's observed failure and from operating the supervisor once:

1. **Supervisor false positive is a campaign hazard, not a pass.** Successor-1
   died at +0.9s of its first phase because process identity included `comm`,
   which legitimately changes when a freshly spawned child finishes `exec`.
   The INCOMPLETE receipt is retained and hashed in
   `campaign-successor-2/registration.json`; identity is now `(pid, start
   instant)` only. A supervisor that cries wolf must still stop the campaign —
   never "fix forward" by editing the journal or rerunning under the same
   registration.
2. **No journal repair.** The successor-1 journal stays sealed. Successor-2 is
   a new preregistered campaign with the unchanged 3600s cap, the same
   mandatory 23 owner + 14 retained-S5 cases, the original predecessor red
   receipt, and successor-1 receipts chained as predecessors.
3. **Exec-window processes.** Any guard that fingerprints processes must treat
   the pre-exec window as unstable and must never fingerprint mutable
   attributes (comm, state, rss).
4. **Registration discipline.** This file and `registration.json` were written
   and committed before any successor-2 behavioral phase ran. The scientific
   runtime probe result observed during successor-1 (numpy 2.3.3, scipy
   1.16.2, real `scipy.optimize.milp` status 0) is re-verified inside
   successor-2 rather than carried over as qualification.
