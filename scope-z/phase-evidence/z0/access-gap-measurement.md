# Z0-R12 access-gap measurement

Source head: `06965d450ec58456863f8c435b71fa71bba2a279`. Family source manifest sha256: `b3c8f1783a5ac332cab539c962a0fbc00c16d79065ac298cffa13207a556a79d`.

Rule (preregistered in `scripts/project-z/z0/measure-access-gap.mjs`): eligible = W and K and O and F and not Project Z; access gap = eligible and not Q and not P; selection = max gapSize, then fewer source lines.

Counts: {"productionJobTypes":75,"registeredJobTypes":75,"unregisteredProductionJobTypes":[],"familiesMeasured":37,"familiesWithWorker":30,"eligible":3,"accessGap":3,"httpCapabilitiesInGapFamilies":28,"gapOperationsInGapFamilies":5,"totalCoverageGapRows":95,"companyBrainOperationsAmbiguous":11,"companyBrainOperationsUnresolved":7}

| rank | family | gapSize | http ops | source lines | job types |
|---|---|---|---|---|---|
| 1 | primary-diligence | 5 | 10 | 1691 | advance_primary_diligence_v1 |
| 2 | r4 | 0 | 8 | 1097 | run_identification_plan_v1 |
| 3 | r7 | 0 | 10 | 1232 | run_decision_atlas_v1 |

Selected: **primary-diligence**.

Excluded families (worker present):

- application-semantics: W=y K=y O=y F=y Q=n P=n (first family)
- bilateral-opportunities: W=y K=y O=n F=y Q=n P=n
- branch-fabric: W=y K=y O=n F=y Q=n P=n
- capital-formation: W=y K=y O=n F=y Q=n P=n
- capital-program: W=y K=n O=y F=y Q=n P=n
- closing: W=y K=n O=n F=y Q=n P=n
- compute-search: W=y K=n O=n F=y Q=n P=n
- confidential-computation: W=y K=n O=y F=y Q=y P=n
- counterexample-search: W=y K=y O=n F=y Q=n P=n
- economic-action-theory: W=y K=y O=n F=y Q=n P=n
- enterprise-applications: W=y K=y O=n F=y Q=n P=n
- evidence-execution: W=y K=n O=y F=y Q=n P=n (first family)
- institution-program: W=y K=y O=n F=y Q=n P=n (first family)
- interface-synthesis: W=y K=n O=n F=y Q=n P=n
- live-controls: W=y K=n O=n F=y Q=n P=n
- live-recompilation: W=y K=n O=n F=y Q=n P=n
- policy-learning: W=y K=n O=n F=y Q=n P=n
- procedure-induction: W=y K=n O=n F=y Q=n P=n
- program-synthesis: W=y K=y O=n F=y Q=y P=n (first family)
- project-z/z2-coalitions: W=y K=y O=n F=y Q=n P=n (Project Z)
- project-z/z3-viability: W=y K=y O=y F=y Q=n P=n (Project Z)
- project-z/z4-execution-proof: W=y K=n O=y F=y Q=y P=n (Project Z)
- project-z/z5-institution-linker: W=y K=y O=y F=y Q=n P=n (Project Z)
- r1: W=y K=n O=n F=y Q=n P=n
- r3: W=y K=n O=y F=y Q=n P=n
- strategic-response: W=y K=n O=n F=y Q=n P=n
- system-identification: W=y K=n O=n F=y Q=n P=n

First families (imports of z0-convergence, excluded): allocation-store, application-semantics, enterprise-beliefs, evidence-execution, institution-program, program-synthesis, types

Routes not credited to any family (shared import or non-persistence owner): 41, of which unmounted-gap rows: 14

