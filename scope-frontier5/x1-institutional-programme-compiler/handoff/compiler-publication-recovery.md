# Accepted-child publication recovery

The compiler stores a versioned, bounded publication checkpoint in its existing private Work input manifest before accepting the native P1 child. It keeps checked projection metadata and the exact original native request. Raw bodies remain in S1/Core. Recovery validates current owner dependencies, immutable S1/checker records and mapping attachments before replaying the exact P1 idempotency request. The checkpoint is removed in the actual immutable artifact commit.

If an already accepted child failed while the parent was UNKNOWN, authenticated compiler resume republishes the retained checked projection and uses the existing P1 resume operation. The original child, compiler/native episodes, deadlines, reservations, prior failed jobs, effects and costs remain retained. A new independent observation is required for completion. Neither the checkpoint nor queue acceptance grants effect authority.

This change requires the matching compiler worker, publication-checkpoint module, source-admission reader and S8 method source identity together. No SQL migration or new job/protocol version is introduced; schema head remains 0190. Ordinary pre-X1 P1 jobs retain their existing handlers. An accepted X1 child from an earlier development cut without its original checkpoint refuses with X1_ACCEPTED_CHILD_REQUIRES_ORIGINAL_PUBLICATION_CHECKPOINT rather than rebuilding and replacing its admitted basis. Preserve that unresolved child for owner-led recovery; do not roll back to an older worker and blindly replay it.

Repeatable physical case:

```sh
node finnor-os/scripts/frontier5/x1/verify.mjs --stage lifecycle --case accepted-child-recovery --evidence /absolute/fresh/private/evidence
```

The directory must be a fresh direct child of the registered private evidence root. The driver holds the actual artifact INSERT after native acceptance, SIGKILLs only its owned worker, observes orphan UNKNOWN, authenticates original resume, and verifies the same child plus independently observed canonical completion. Original 840/880-second driver/supervisor, original S5 envelope and resource floors apply. Separate pre-admission and lost-effect-acknowledgement cases retain their own evidence domains.
