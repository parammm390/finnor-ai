# FINNOR Epistemic Runtime P3

P3 starts from workspace HEAD `8fcd8a1cebcf92791047777c0d9c70e95fc7aad2`. At the start of P3, P2 closure was still running; the latest locally certified P2 candidate was `856c0cc370adc35490b18f9dc1d7244bcf46266f`. P3 therefore began as a pure, read-only package with no production routing or execution authority changes.

`@finnor/epistemic-runtime` transforms already assembled context and audited observations into a replayable `EpistemicState`, classifies decision-critical uncertainty, ranks typed read-only information actions, appends immutable evidence, and recomputes belief. Canonical truth remains a separate deterministic projection and the exact existing precedence remains `CANONICAL > WORK > PROFILE > SESSION > MEMORY > WEB`.

The package does not own context assembly, canonical queries, memory, source truth, provider/computer execution, BusinessEffect, Authority, Work, Objective, or CausalReplay persistence. It consumes those existing contracts through injected read-only adapters. Its initial orchestration role is shadow-only: the authoritative planner result is returned by identity, there is no second planner call, and the trace contains structured decisions rather than prompts, values, credentials, raw provider payloads, or chain-of-thought.

The permanent P3 extension corpus contains 24 frozen cases at `2026-08-31T00:00:00.000Z` with seed `31082026`. It has no live provider or web dependency. Run `npm run test:p3:unit`, `npm run test:p3:locked`, and `npm run p3:certify` after P3 is reconciled onto the certified P2 lineage.

Authoritative epistemic cutover, automatic consequential execution, stochastic probability calibration, new retrieval stores, and new authority semantics are explicitly outside P3.
