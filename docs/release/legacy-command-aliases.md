# Legacy release command aliases

`release:p0-p4-lineage` and `release:p0-p6-lineage` were dangling package scripts: the first referenced an absent file and the second an absent backend script. Neither had a surviving phase-specific implementation in the current source. They remain callable for compatibility, using the current canonical release checks:

- `npm run release:p0-p4-lineage` runs deployment truth and the complete existing release governance regression suite, including mutation inventory validation.
- `npm run release:p0-p6-lineage` runs that same gate, then the current Private Equity runtime contract and product capability catalogue check.

These aliases do not certify historical phase completion, deploy a release, or grant mutation authority. Exact release provenance, migration lineage, live parity, protected admission and economic qualification keep their existing separate gates. Prefer the explicit canonical command names in new automation.
