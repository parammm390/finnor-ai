# Original-byte finite metalevel profile v1

Failure contract: `failure-model.md`. Written before the reference and producer.

Input is UTF-8 JSON with schema `finnor.metalevel-model.v1`. Duplicate JSON keys and nonfinite numbers are invalid. Rational quantities are exact signed integer, decimal or integer/fraction strings, with the existing R2 512-digit numerator/denominator bound. No floating decision arithmetic.

Root fields are schema, id, binding, utilityUnit, rootStateId, maxDecisions, tieOrder, states. Binding has tenantId, principalId, workId, outcomeRef, mandateRef, sourceRef, rightsRef, catalogueRef, responseRef, modelRef, priceRef, checkerRef, runtimeRef, parentGrantRef, deadline. These are references, not authority receipts.

There are 1–64 complete supplied states, 1–16 choices/state, and 0–8 computation decisions. Root decisionIndex is zero. Each compute edge advances decisionIndex exactly one. All supplied states/choices/outcomes are validated, including unreachable states. Each state has an explicit full history, remaining resource vector, obligation records, required/completed verification references, acceptance receipt or null, and choices. Model authors assert state completeness; checking the finite table does not prove real-world adequacy.

A stop choice contains utility, disposition (ACCEPTED/INCOMPLETE/UNKNOWN/ESCALATE), and resultRef or null. ACCEPTED requires a non-null independently owned state acceptanceRef/resultRef, every required check completed, and no PENDING/UNKNOWN obligations. This is a binding check, not verification that a referenced receipt is authentic.

A compute choice contains computationRef, contextRefs, dependsOn, verifierRefs, utilityCost, reservation, and outcomes. Catalogue and authority applicability are checked by the native consumer, not granted by this model. Outcomes contain observation, kind (VALID/INVALID), probability, utilityDelta, consumption, nextStateId. Every compute choice explicitly supplies one INVALID branch. Unrecognized runtime observations take that branch and invalidate empirical applicability; an impossible observation is not silently treated as independent evidence.

Resource vectors have identical named dimensions throughout. All balances/demands/consumption are nonnegative rationals. Reservation does not exceed current remaining; each outcome consumption does not exceed its reservation; successor remaining equals original remaining minus that outcome's consumption. Native S5 still performs actual reservation and physical occupancy checks. Obligations cannot disappear from a successor or lose an unresolved identity. UNKNOWN/PENDING can resolve only with a non-null resolution reference, which the actual owner must independently verify.

History is an array of `{choiceId, observation}`. Each successor history equals the predecessor history plus the observed choice/token. Different histories therefore cannot be merged by this first profile. Missing sufficient-state compression is unsupported, not silently assumed Markov.

Bellman semantics: stop value is its supplied utility; compute value is `-utilityCost + sum(probability * (utilityDelta + successorValue))`. Current state and outcome charges represent state/history-dependent and joint costs; no additive-benefit or independent-error assumption is made. Every probability is nonnegative, each row sums exactly to one, outcomes have unique tokens, and all targets exist at the next decision index. At maxDecisions only stop choices are allowed.

Tie order is one original-input total order covering every distinct choice identity exactly once. Preserve every exactly optimal choice at every state; select its first member in that order. No epsilon tie or sampled-optimality claim. The independent reference and producer return original-byte SHA-256, every state's exact value, every choice value, optimal choices and selected choice. A capsule with altered model bytes or incomplete state coverage must fail.

The development complementarity fixture has initial stop 50, first computation cost 1, second cost 1 and equally likely informative left/right outcomes with terminal utility 100. Its exact optimal value is 98; initial stopping remains an available 50 alternative. Invalid observations preserve an incomplete incumbent, not fabricated success.
