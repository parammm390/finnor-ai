# Continuation fixture budget correction contract

Registered after the retained campaign-0001 failure and before correction.
`evidence/campaign-0001/continuation/mechanics.json` records 15/16 passing
cases; `same-capsule-nonroot-consumption` expected DISPATCH but got FALLBACK.
The original fixture moves the frame past one physical action while retaining
the root's entire remaining attempt, step and wall budget.

Diagnose the actual fallback reason using the retained original input, sample,
model and current consumer before changing the fixture or production code.
The sample's recorded consumption is one attempt, one logical step and one
millisecond. Its positive successor must therefore carry remaining attempts
19, steps 999 and wallMs 9999, not the root's 20/1000/10000. The separate
publication reservation stays unchanged. No new allocation, grant or deadline
is created.

The positive oracle remains DISPATCH of exactly B-execute at a non-root
checked state using the same capsule. For each resource dimension, restoring
one already consumed unit must refuse rather than dispatch. Keep the original
16 case identities and every other assertion. Do not relax the consumer's
resource matching, independent policy checker, kernel limits or original
business bounds. Preserve campaign-0001; corrected bytes require a new epoch.

This is conditional-mechanism fixture evidence, not native physical E2E,
empirical gain or whole-W1 completion.
