# Existing IC preparation continuation

Failure modes before the continuation change: creating a duplicate active IC case; finishing after only an underwriting run; dropping an older canonical base from a bounded recent-run window; replacing a memo without recording a material version; reusing a recommendation pinned to the old run; changing a terminal decision; or repeatedly retrying a check-only plan with no new evidence.

A unique existing case in a preparation/review phase can use the existing governed `select_ic_underwriting_run` owner. The exact new run must belong to this Work and investment case. Memo drafts, material memo selection, recommendation and review continue through existing actions, version guards, approvals, BusinessEffects and receipts. Terminal cases and ambiguous active cases are not silently changed. Existing votes and decisions remain governed by the canonical IC owner.
