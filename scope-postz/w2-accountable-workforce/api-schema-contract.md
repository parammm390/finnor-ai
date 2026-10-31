# Workforce HTTP schema ownership

The integrated release generator fails at the actual human-form owner because
POST /api/workforce/participants is implemented and exposed by the capability
inventory but absent from OpenAPI. Audit the complete new workforce route set,
including reads, participant disposition, intake, submission, actions and recovery.

Failure cases are a missing real method or path, a request schema copied apart
from its runtime parser, an omitted required path/query identifier, changed
validation semantics, stale generated clients/forms, or source drift during a
read-only check. Export and reuse the actual canonical schemas; do not suppress
controls or weaken the generator. Preserve current signed-bearer authorization
and every runtime owner check.

The actual complete generator, its read-only repeat, source/type checks and
unchanged owning HTTP journeys verify this source repair. Schema generation is
not participant consent, successful settlement, or end-to-end qualification.

The unchanged read-only coverage check additionally rejects the mounted panel's
open-ended string mutation target. Encode submission, assignment action and
recovery as three explicit variants with their actual literal route construction
at the canonical client call. Preserve shared scope invalidation, currentness,
error handling and refresh; no arbitrary route or audit exemption is added.
