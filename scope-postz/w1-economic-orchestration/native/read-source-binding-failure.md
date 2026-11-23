# Independent quote source binding, failure before repair

The original HTTP review-v2 BEFORE artifact remains FAIL, including 27 passed
checks, 20 failed review checks and an incomplete-source-freeze failure.
QUOTE_EXPLICIT_SUBJECT incremented work_planner_attempts from 0 to 1; all seven
other activation counters stayed unchanged for that predicate. This is not zero
activation. A process exit of zero did not qualify the failed artifact.

SIMULTANEOUS_QUOTE_VALIDITY did not reach quote freshness selection. The actual
PostgreSQL error in http-0005-before-v2-wrapper.log:76 and :110 is unique
constraint external_refs_internal_provider_idx. The second source used its own
actual integration and verified source scope, but the old index omits that
integration. Migration 0025 created it as an index; migration 0099 attempted
DROP CONSTRAINT and therefore did not remove it. The latter installed the
intended internal/external binding unique indexes alongside the obsolete one.
Do not label the quote-selection predicate demonstrated by this setup failure.

Repair the canonical migration chain with one new immutable migration that
removes only the obsolete index. Preserve the newer per-integration unique
indexes, tenant/source foreign keys, permissions, RLS, mappings and old migration
bytes. Regenerate the canonical bundle. No direct fixture DROP INDEX, fabricated
provider, different issuer, bypass or weakened quote assertion is allowed.

The real HTTP E2E must exercise both integration orderings with simultaneous
agreeing quotes, one expired source, both expired sources and price/session/delay
conflict controls. It must also observe the surviving canonical unique indexes
and reject a duplicate within a single integration with its actual 23505 error
and exact binding constraint. Freeze a new before-read-repair epoch after the
migration correction. The first artifact remains immutable; neither this
migration nor a subsequent type check proves quote semantics.

Credible failures include removing the wrong constraint; changing historical
migration bytes; losing same-integration uniqueness; accepting ambiguous source
ownership; expiry chosen by UUID order; selecting an unlicensed source; hidden
activation; stale artifact/source hashes; cleanup or exit hooks masking failure.
The existing 47 HTTP predicates and mandatory independent artifact verifier own
read acceptance. No post-code unit test is introduced.

After the compound quote predicate, restore both independent sources to the
original complete quote. Changing one to a different symbol of the same issuer
would correctly make later issuer-NAME queries ambiguous and contaminate those
separate predicates. Keep the independent source and its history rather than
deleting evidence or editing source-currentness rows directly.

The corrected-source BEFORE run is retained at
evidence/reads-native/http-0006-before-source-binding. It applied 233 migrations
and now reached the real quote assertion: STALE was returned instead of CURRENT.
The same-integration 23505 negative control passed. The whole artifact is FAIL
(26 PASS, 22 FAIL), and its independent verifier correctly returned exit 1.
The extra lawful quote also contaminated the later original single-source
SOURCE_DELAYED control, which returned CURRENT. Do not classify that as a new
reader defect. Run all 23 original predicates before introducing the additional
independent source; then restore the explicitly seeded original source scopes and
quote before the 24 review predicates. Preserve every original assertion and
registered identity. The HTTP source freeze and verifier must bind the new
canonical migration, bundle and generator as well as the original sources.
