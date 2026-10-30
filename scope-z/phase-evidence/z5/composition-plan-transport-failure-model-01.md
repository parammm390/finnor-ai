# Original S4 planning refusal transport model

This additional source-inspection model precedes the assembler correction.
It supplements, rather than rewrites, the earlier consumer-publication
model. The consumer fix alone does not need a shared edit. Inspection of
the strengthened native flow exposed a separate existing proposal gap.

## Actual source and expected refusal

The original `api/policies/[operation]/route.ts` catches named S4/R1 errors
but sends an ordinary `Error("Z5_...")` to the generic `errorResponse`.
`api/lib/auth.ts` implements that fallback as an unhandled route failure,
not an expected original-contract refusal. The request-06 composition-plan
case adds no Z5-specific handling. A correctly refused cancelled composition
plan would therefore surface as an unexpected 500 instead of a typed 4xx.
This is inferred from the actual source, not an authenticated HTTP run.

Only the proposed `composition-plan` case needs a local bounded Z5 catch.
Keep the existing original handler for every non-Z5 exception, including
Auth, Zod, existing S4 types and unexpected failures. Do not broaden the
global route's error policy, redact unknown failures into success, bypass
authentication, change S4 semantics or write the coordinator-owned file.

Known uppercase Z5 codes use the existing owned API's distinction:
IDEMPOTENCY/STALE/CURRENT/CHANGED/FENCED/EXHAUSTED conflicts return 409;
other bounded Z5 original-owner refusals return 403. Return only the bounded
code and a fixed error message, with false protected/effect authority and
retained old exposure. Missing/invalid JSON keeps the original 400 path.
No successful plan, debit or consumption event is fabricated.

Generate fresh exact-preimage request 07, leaving requests 01–06 immutable.
Require strict read-only `git apply --check --whitespace=error` and independent
pre/postimage verification before treating the patch as engineering-valid.
Only the policies-route postimage should differ from 06; the other ten
postimages and all eleven preimages/migration metadata must be identical.
Point the source packager to 07 without executing or bypassing its guard.
Run the changed backend graph against actual virtual request-07 bytes.

## Validation boundary

The root ESLint configuration explicitly ignores `finnor-os/**`; the backend
package has no configured lint command. Do not claim ignored backend files
were linted. Inspect that applicability and retain the existing unaffected
frontend lint receipt. Changed native MJS gets syntax checking; all affected
backend source gets the existing whole-graph compiler check.

The guarded native flow requires 4xx for cancelled admission/use/planning,
no durable cancelled-state change, and explicitly does not claim to schedule
an in-flight cancellation race. Its current permitted execution is only the
credential-free refusal guard, exit 2, before DB/Auth/network imports.
Real HTTP/refusal/concurrency behavior remains NOT_RUN without separately
authorized existing native owners/custody. No new authority is created.
