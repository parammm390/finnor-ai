# Successor-5 campaign failure model (delta)

Inherits all four prior failure models. Addition from successor-4's observed
DISK_RESERVE enforcement:

1. **Shared-volume headroom is a campaign input.** Successor-4 did everything
   correctly and still could not finish: accumulated postgres data dirs,
   serial cuts, repro dirs, and scratch cuts across sibling campaigns pushed
   `/tmp` to the 256MiB reserve floor (237,830,144 free bytes observed). The
   guard fired, the decision-work fence blocked new work, and reconciliation
   completed cleanly — the intended behavior, but it means disk hygiene is
   part of the campaign design, not an afterthought.
2. **Phase tmp is regenerable and must be pruned.** The orchestrator now
   deletes each phase's `tmp` (disposable databases/HOME) after the phase
   receipt is sealed; failed phases keep tmp for forensics and are reclaimed
   by the operator between campaigns. Evidence, receipts, logs, and results
   are never pruned.
3. **Scratch artifacts have explicit lifetimes.** Repro dirs and scratch cuts
   from this session were deleted; serial-cut manifests were preserved inside
   their campaign roots before the cuts were reclaimed (cuts are regenerable
   from `serial-projection.mjs` + the pinned base).
4. Successor-4 remains sealed INCOMPLETE. Its receipts (22/23 owner PASS,
   one fenced failure `GLOBAL_CAMPAIGN_STOPPED_NO_NEW_DECISION_WORK`, clean
   reconciliation, DISK_RESERVE supervision) are chained in
   `campaign-successor-5/registration.json`; successor-5 re-establishes the
   full case sets under its own clock.
