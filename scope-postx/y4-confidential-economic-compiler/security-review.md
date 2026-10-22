# Y4 local security review

Scope: the Y4 change against
`b7b74b48efcb51bd6f1297a71f39cb9b4f117024`, including its untracked
compiler, migration, UI and engineering drivers. This is a source review, not
an independently issued deployment-security qualification or production approval.

## Result

No high-confidence reachable security finding was established in the reviewed
change. Missing engineering and qualification observations remain separate open
gates; they are not inferred from this result.

## Reviewed boundaries

- Authenticated Company Brain routing, strict bounded request schemas, original
  Work intake, plan identity, idempotency, canonical authority and tenant scope.
- Opaque X1 source issuance and verification-only currentness, private owner
  cuts, immutable grants/deadlines, cumulative stable-source reservations,
  recipient release import, revocation and derivative isolation.
- Independent ordered-term, dimension, interval and output correspondence;
  exact signed arithmetic and selected-branch validity; native emission,
  participant reconstruction, commitment checks and recipient-private openings.
- Pinned MASCOT/SoftSpoken configuration, native/compiler/library identity,
  fresh session state, uncertain-session refusal, process bounds and logs.
- Underwriting input/result hiding, native read currentness, generic events,
  and refusal of unadmitted artifact, IC and live-control mutation sinks.
- Operational query, ordinary queue/worker and Work completion integration;
  mounted WORLD principal/resource/generation fencing and output rendering.
- The complete intended cut named by the final source-review manifest,
  including inherited S4/S5/S6/S8 and queue changes, both SQL migrations,
  neutral bounded references, browser code, reconstruction and adverse drivers.

STRIDE, applicable OWASP Top 10 and LLM tool-authority boundaries informed the
first pass. The second pass traced candidate paths through existing route
authentication, owner currentness and RLS rather than reporting missing controls
from isolated snippets.

## Generated contract comparison

Structural JSON comparison, not line-count inference, found:

- OpenAPI adds exactly 16 confidential-operation paths and 16 schemas.
- No prior path or schema is removed. No prior named schema changes.
- The only changed existing path is the generic Company Brain operation union.
- The capability manifest retains every prior entry and adds 17 entries
  (16 HTTP operations and one planner query).

The inherited executable query registry increases from 17 to 18. Existing
release-boundary assertions were updated for that explicit additive query.

## Supply-chain observations

No repository package manifest or lockfile is changed. Registry enrichment was
not run; no dependency freshness, maintainer or current advisory conclusion is
claimed. Runtime airgap resolution for this review was connected mode, with
no public-network or registry request performed.

The task-local native build pins MP-SPDZ, libOTe, cryptoTools, the SHA-256
circuit, 38 upstream Python compiler files and 17 runtime libraries/loaders.
The rejected KOS15 path was not made executable with `-DINSECURE`.
Successful build exit alone is not accepted computation evidence.

Inspected notices: MP-SPDZ BSD-3-Clause and inherited Bristol/KU Leuven terms;
libOTe and cryptoTools MIT/Unlicense; SimplestOT Unlicense; circuit notices.
The offline archives retain the notices present in the pinned package and
native/distro custody. This is not independent legal clearance, current
vulnerability enrichment or an upstream-source rebuild. No outward
redistribution, upstream contact or publication was performed.

## Separation from qualification

Task-local hardlinks, common-host participants, local auth and a component host
are explicitly non-independent. They do not issue protected admission,
separately administered security, deployed Next qualification, source truth,
S4/S5/S6/S8 onward admission, effect authority or economic benefit.

Live protocol-fault, cumulative/adaptive, crash/recovery, unrelated-effect
preservation and clean independent reconstruction gaps must remain visible in
the completion record even if the installed happy path passes.
