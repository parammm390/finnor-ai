# Backend CI repair

Observed cut: `f9ca7cf8ba663f881c16e9b9418a4479f34df407`.
CI reported 38 failed tests in 10 files, with 1,242 passing.

Failure classes to investigate before changing behavior:

- A non-UUID system actor reaches a UUID cast in new evidence RLS.
  Preserve denial of capital-private evidence and allow ordinary authorized
  provider observations without an actor-cast exception.
- Ordinary durable actions remain compiled rather than authorized.
  Recover exact approval, durable enqueue and settlement, without bypassing
  capital-specific or live-control approval fences.
- Historical closing fixtures lack the newly required independent ClosingSpec.
  Do not restore legacy close authority on the current schema to satisfy them.
- Upgrade fingerprints include whole rows across additive column changes.
  Compare every original column and row; separately validate new-column defaults.
- Two ownership checks still expect 45 actions, while the actual registry has 46.
  Derive the expected inventory from its executable contract.

Verification uses a newly owned loopback PostgreSQL database, real migrations
and existing integration tests. No production database, deployment, provider
credential, expired grant or existing R-phase runtime is used.
