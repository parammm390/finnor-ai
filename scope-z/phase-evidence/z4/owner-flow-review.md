# Source-grounded owner-flow corrections

Before the next executable native replay/build, review found these failure paths:

* A verified completed Work changes its selected PlanRevision to `completed`.
  The earlier read required `active` even in historical-read mode, hiding valid
  same-input completion metadata. Allow only an actual verified completion proof
  for that exact completed Work/plan, never owner use or a superseded plan.
* A canonical query could read an ACKNOWLEDGED snapshot while cancellation or
  invalidation happened during native artifact readback. Recheck currentness and
  the exact durable Z4 state before returning positive completion metadata.
* The shared canonical parser, Drizzle query-intent type and boundary verifier
  also require additive wiring. They are included in exact-preimage requests.
* Rust vendoring initially failed offline on an absent non-host dependency
  (`android_system_properties 0.1.6`). Keep the failure. A separately named
  bounded retry may fetch only the unchanged pinned Cargo.lock closure. The
  staged rebuild itself remains network-disabled.

Expected observations: completed same-input metadata remains readable only
with current rights/source/deadline; completion never permits another use;
concurrent state changes cannot produce `nativeOwnerConsumed:true`; malformed
or public-facade native queries refuse; the isolated build consumes vendored
dependencies only. Authenticated observations remain NOT_RUN without authority.

## Installed identity and staging compilation

An isolated target nested under the lane could inherit the parent's Git
discovery. Both runtime identity and replay must require the observed Git
toplevel to equal the declared root, otherwise verify declared installed
provenance against actual source/native bytes. A pure source/native identity
module permits that observation without DB/Auth imports.

`NODE_ENV=production` describes a compiled Next build, not production access.
The ordinary-disposable guard must require explicit staging plus the exact
ordinary-disposable profile and reject production deployment markers. It
must not make every separately installed production-mode build unusable.
Expected observation: compiled staging remains eligible for separately
authorized ordinary execution; missing profile, non-staging or production
deployment remains refused. No actual native execution is authorized here.
