# Native liveness repair verification

Before implementation, verify these failure boundaries with real processes and
ordinary PostgreSQL roles:

- A stopped required service must terminate an active scenario promptly and
  retain the first observed exit, including an unexpected zero exit.
- Scenario success, failure and signal outcomes must retain their exact result;
  later cleanup must not replace the first failure or qualify missing cases.
- Controller heartbeats must renew under a competing tenant business writer,
  refuse stale nonce/generation and expired leases, and leave the material cut
  and original budget unchanged. Material updates must remain serialized.
- A newly created R4 fixture must retain its original one-day horizon across
  midnight. Previously issued grants must still expire without renewal.

The pending migration is ordinal 266. Its complete generated inputs, role
plans, confidentiality checks and native compensation comparison remain
required. A synthetic canary record will replace the embedded business-specific
record before publication; authentication and extraction fields remain required.

All Z/W installed-owner, protected-effect and measured-business gates remain
open until their complete evidence is available. W4/W5 sources remain absent.

## Verified candidate results

The real R4 owner journey passes its five unchanged cases: migration/replay,
owner registration, native checked plan, owner dispositions, and privacy.
The original failure was run 43775909228, job 133003375343: its grant was
created five seconds before its midnight-rounded horizon expired. The fixture
now freezes its initial clock without rounding; no issued grant is renewed.

Migration 266 applies once and replays zero times on a private native-fixture
copy. An ordinary worker heartbeat completes in 13 ms while a competing writer
remains held. Stale nonce, stale generation and expired renewals refuse. The
business cut, original budget, 80 unrelated fences and existing table privileges
are unchanged; mixed business updates remain serialized. Reader-policy and
confidentiality verification reports no failures.

Six real process-lifecycle cases and four synthetic-canary HTTP cases pass.
The full release/governance call chain and pinned workflow validator pass.
The canary's embedded business-specific content is replaced with an explicitly
synthetic record while preserving authentication, routes and extraction fields.

Published parent: 1892a2926a98bcac79a5db664f70574fe39c9b67.
Z0 and the complete five-episode W2 settlement comparison remain open.
