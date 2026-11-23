# PR 187 Auth startup repair

The native owner launcher did not create its private state parent in a fresh
checkout. The Auth starter therefore exited before readiness. The launcher now
creates only the parent and refuses existing state, invalid names and symlinks.

Reviewed parent: e6ba8c3ab26964d2f5ba7dad9919d31b7e92cabb.
Failing Actions run/job: 43775909228 / 133003866352, attempt 1.

Validation: filesystem boundary checks, actual pinned Auth and disposable
PostgreSQL startup, and the complete governance call chain pass locally.
The original owner login/reload check remains required on published source.

This correction grants no new effect authority. Z/W phase acceptance,
settlement, the mounted journey, R4 and security remain open. The pending
controller-lease correction is not part of this publication.
