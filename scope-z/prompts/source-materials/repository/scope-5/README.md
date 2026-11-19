# Frozen S5 — shared commitments

Joint finite resource clearing, independently checked allocation certificates, uncertainty, current owner inputs and conservative outstanding occupation. The original solver, verifier and separate-worker validation are retained.

PR 5 in the ordered S1 → S6 stack supplies the allocation core. Authenticated S4/S5 APIs and existing owner E2E runners are in PR 6 because allocation settlement reads actual S6 obligations and S4 rechecks S5 allocation. Original historical status/plan qualifications are unchanged. No allocation certificate is an execution grant or independent admission.

Current main already uses migration numbers 0148 and 0149. The existing portfolio-clearing SQL is appended as 0150 with identical bytes, preserving every historical main migration.
