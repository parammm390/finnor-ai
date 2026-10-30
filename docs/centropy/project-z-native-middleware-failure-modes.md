# Native middleware convergence, failure before code

The real isolated app attempt 03 failed. PostgreSQL migrations, both fixture
seeds, real Auth password login and the restricted-role owner mapping passed.
Actual GET /api/me requests did not reach the authorization boundary: API
Next 15.5.28 middleware raised `ReferenceError: __dirname is not defined`
inside its bundled p-queue dependency and returned 404. Its native private log
and failed app receipt remain under `.centropy-certification/project-z-20261026-05`.

The API webpack callback currently applies Node-only source custody and real
`__dirname`/`__filename` preservation whenever `isServer` is true. Establish
whether that includes the Edge middleware compilation before changing it.
Do not remove middleware, exempt /api/me, supply a fake identity, enable auth
bypass, change the expected status, or repair installed dependency bytes.

Required observable outcomes after the narrow packaging repair:

1. The same unauthenticated /api/me request returns 401, not 404/500.
2. A genuine local Auth session maps through the original restricted identity
   resolver and returns the existing owner/user/tenant IDs.
3. The mounted login and reload consume that identity without forged headers.
4. Node-only canonical-source custody remains unchanged for Node API routes.
5. Preserve failed attempts and execute only the unfinished app startup against
   the retained, already bootstrapped isolated database.

These are ordinary development convergence checks. They grant no protected
admission, fresh proof allowance, installed verification or phase acceptance.
