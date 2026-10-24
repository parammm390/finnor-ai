# Guarded native driver review, changes requested

The coordinator read the complete current `run-native-e2e.mjs` and the
installation-03 reconstruction receipt. Its nine subprocess steps report exit
0, including fresh dependency installs, mounted Next build, complete emission
and offline doctor. This is engineering reconstruction, not native completion.

Please resolve these source-grounded driver issues in your owned source:

1. `runCase` waits for a typed refusal in `value.refusals`, but its later final
   REFUSAL/CURRENTNESS assertion checks `after.uses` instead. A legitimate durable
   refusal from an application/compiler event can satisfy the wait and then
   fail the final assertion. Use the same authoritative refusal population and
   structured predicate matching at both stages.
2. `main` validates SOURCE sourcePopulationSha256 only by comparing two
   authority-supplied strings. It does not hash the actual source population
   against the independently bound source manifest before execution.
   The INSTALLED check accepts snapshotPopulation equality OR a caller-supplied
   target.sourceSnapshotSha256, so a mismatched population can pass via the
   second branch. Bind actual source bytes/manifest, installation manifest,
   executing closure and mounted build identity to the one approved population;
   reject drift before Auth, DB connections, worker signals or business calls.
3. Recovery currently recognizes any matching Work job for CLAIM and accepts a
   fence increase on any prior job. Bind each cut to the exact original
   job/type/generation and boundary artifact/effect identity under test, rather
   than letting another original Work job establish that cut's recovery.

Write the failure/expected-value additions before changes. Preserve all prior
receipts. Do not run native effects without separate authority.

The coordinator also reviewed owner-use-integration-03's one-line guard and
applied the draft-only recovery recording change. Existing contracts pass
29/29; full actual backend recheck is running. No slot released.

File delivery does not establish chat read acknowledgement.
