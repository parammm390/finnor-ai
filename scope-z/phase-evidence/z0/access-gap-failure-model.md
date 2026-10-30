# Z0-R12 access-gap measurement: failure model

Scope: `finnor-os/scripts/project-z/z0/measure-access-gap.mjs` selects the second scientific family for Z0 (PRD 4.4, "chosen from a measured access gap rather than ceremonial registration"). No source defines the measurement (matrix ambiguity A06), so the rule is fixed in the script header and every run keeps its inputs, output and hash. A wrong selection would send a whole implementation (query intent, reader, migration, E2E) at the wrong family, so the ways it can be wrong are listed here and each observed one is kept as a retained failing run.

## How the measurement can be wrong

| ID | Failure | Why it matters | Independent check |
|---|---|---|---|
| M1 | Family detection anchored on the literal path `packages/private-equity/src/`, so imports through the `@finnor/private-equity/src/...` alias or a relative path are missed | The universe shrinks silently; a family with a worker looks like it has none | Registered production job types (75) must all resolve to a family or be listed as unresolved; count of families with a worker is compared with the count of worker imports |
| M2 | A route that merely imports a helper from a family is credited to that family | Cross-cutting owner routes (S5 allocations, S6 obligations) inflate an unrelated family's access gap | Each credited route is printed with its coverage `owner` and imported families; only routes owned by `@finnor/private-equity` that import exactly one family are credited |
| M3 | The "second" family is the same family Z0 already delivers (the X1 to X2 path) | PRD says second; selecting X2 or X1 again is ceremonial | The excluded set is derived from the imports of `packages/orchestration/src/project-z/z0-convergence`, never hand-listed |
| M4 | Eligibility signals (independent checker, owner consumption, fixture) are static heuristics with false negatives (checker kept in another package, consumption named differently) | A genuinely eligible family can be dropped, an ineligible one kept | Declared in `limits`; the chosen family is read by hand and its checker, consumer and fixture are named in the report; the E2E is the real oracle |
| M5 | Unstable ordering on ties | The same inputs pick different families on a rerun | Sort keys are total: gapSize desc, source lines asc, family name |
| M6 | The rule is tuned after seeing results | Selection becomes ceremonial | Rule text frozen in the script header; only defects (M1, M2, M3) are fixed after a run; each defective run is retained with its sha256 |
| M7 | Selection is treated as proof | A static measurement does not show ordinary Work reaches the family | The Z0 native session must show before/after on the real stack: before, the typed planner manifest has no capability for the family and an objective query on it is refused; after, ordinary Work observes current owner-consumed state bound to the original Work. Negative cases: wrong Work, other tenant, stale input, revoked authority |

## Observed defects (retained runs)

- Run 01 (`access-gap-measurement.run-01-parser-defect.json`, sha256 79c44428...): M1. Only 9 of 30 workers' families were found; selected `r7` on a truncated universe.
- Run 02 (`access-gap-measurement.run-02-shared-helper-misattribution.json`, sha256 aed62575...): M2. After M1 was fixed the selection stayed `r7` with gapSize 12, but all 12 were S5 `allocations/*` routes (owner `@finnor/api`) that import `r7/accounting`. R7's own `decision-atlases/*` routes have gapSize 0. Wrong fixes rejected: removing r7 by hand, editing gapSize.
- M3 was found by reading the result: `application-semantics` (X2) was a candidate although it is the family Z0's own X1 to X2 bridge already delivers.

## Independent expected outcome after the fixes

- No S5/S6/S7 owner route is credited to any scientific family.
- `r7` gapSize equals the count of its own `decision-atlases/*` routes that the coverage audit lists as unmounted (0).
- The first family (derived from z0-convergence imports) is not a candidate.
- All counts, the per-route attribution and the chosen family are reproducible from `node scripts/project-z/z0/measure-access-gap.mjs` on the committed tree; the inputs' sha256 are in the output.
