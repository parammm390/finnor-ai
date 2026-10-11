# Successor-7 campaign failure model (delta)

Inherits all six prior failure models. Addition from successor-6's second
DISK_RESERVE enforcement:

1. **Repeated guard trips demand footprint reduction, not guard relaxation.**
   The 256MiB reserve is a registered limit and stays. Instead, supporting
   bulk evidence from prior campaigns was compacted into
   `/tmp/finnor-r7-bulk-archives/*.tar.gz`; every receipt path chained in any
   registration stayed raw in place and was hash-verified after compaction
   (`bulk-evidence-archive/manifest.json`, itself hashed into
   `campaign-successor-7/registration.json`). Custody is preserved by hashes;
   regenerability by the archives.
2. **The shared system volume is an uncontrollable co-tenant.** Other
   consumers can shrink free space mid-campaign; the disk guard treats that
   honestly as INCOMPLETE rather than squeezing the reserve.
3. Successor-6 remains sealed INCOMPLETE (11 owner PASS + 2 fenced failures
   `GLOBAL_CAMPAIGN_STOPPED_NO_NEW_DECISION_WORK`, clean reconciliation, zero
   residual processes). Successor-7 re-establishes all case sets under its
   own clock.
