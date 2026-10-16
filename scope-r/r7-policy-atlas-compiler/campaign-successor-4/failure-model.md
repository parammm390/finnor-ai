# Successor-4 campaign failure model (delta)

Inherits all three prior failure models. Addition from successor-3's retained
S5 failure:

1. **Borrowed `node_modules` must never resolve workspace sources.** A
   whole-directory symlink makes `@finnor/*` imports resolve into the borrowed
   foreign checkout — which can silently lack sources present in the verified
   cut (the foreign r2 tree has no `packages/private-equity/src/r1`) or, worse,
   supply *different* bytes for packages the cut claims to verify. The
   projection now builds a symlink farm: every third-party entry linked
   read-only, every `@finnor/*` entry re-linked to the corresponding path
   inside the cut, and any workspace target missing from the cut is recorded
   in `skippedWorkspaceLinks` (failing loudly downstream instead of resolving
   outward). Verified in a scratch cut: 36/36 links internal, zero skipped,
   all three retained S5 route modules import, retained python assets execute
   on the supplied read-only runtime.
2. **The owner lane's relative imports masked this class.** Predecessor R7
   owner runs never touched `@finnor/*` for r1/r7 sources, so the defect only
   surfaced when the retained S5 lane loaded the full API route surface. A
   lane passing is not evidence the cut is hermetic; the projection itself
   must prove it structurally.
3. Successor-3 remains sealed INCOMPLETE; its PASS receipts (23/23 owner
   under the global clock, all five guard E2Es, typecheck, preflight,
   overlay) are chained in `campaign-successor-4/registration.json` and are
   re-established under successor-4's own clock rather than carried over as
   qualification.
