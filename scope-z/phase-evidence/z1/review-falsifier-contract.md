# Pre-fix whole-program review falsifiers

Recorded after the first fresh development reconstruction and **before** the
corresponding implementation fixes. This adds no unit tests and does not
rewrite the original frozen contract or erase its failures.

Named input shape remains two independently identified original Works,
complete source rows/programmes and the actual separate Python checker.
The executable surface is the existing public process E2E runner.

Expected observations to reproduce before fixing:

1. Valid supplementary-Unicode Work identifiers must retain the same candidate
   digest and shared-consumer ordering in both runtimes. Text and canonical-row
   order are UTF-16 code-unit order, not locale order or Python's default
   code-point order. Unpaired surrogates remain unsupported.
2. Valid token identifiers that equal JavaScript prototype names cannot read
   inherited budget properties or silently lose cost-allocation entries.
3. `and`/`or` predicates short-circuit left-to-right. A typed zero denominator
   in a skipped branch must not reject an otherwise defined original result.
   The hand-expected global sums are 0 and 3 for false-and/true-or programmes.
4. A grouped output with 129 columns is outside the declared 128-column profile.
   It must not produce a usable partial candidate.
5. A rehashed otherwise exact candidate must not pass the independent checker
   with altered tenant/build/checker identity, upgraded partial source evidence,
   null authority flags, fabricated zero USD, removed meter gaps, or all-zero
   operation charges. Update cost-reference hashes too so this exercises
   semantic validation rather than accidental digest disagreement.

The cost obligation is a deterministic model check, not independent physical
metering. Every completed active original node incurs one discovery tick and
every shared retained node one storage tick, including reused values. Full
execution-tick and lifetime-budget attestations still need actual prior
canonical checkpoints and independent native physical/resource accounting.

Native checked-publication validation must bind the whole derived envelope to
the exact candidate/check/check-reference, not merely a subset of hashes.
No local file-fixture or unbound port provides a native proof of that boundary.
