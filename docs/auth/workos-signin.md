# WorkOS sign-in

This adapter replaces interactive Supabase authentication. PostgreSQL, FINNOR users,
tenant RLS, employee suspension, roles and authority revisions retain their existing owners.

## Configuration

The frontend server requires `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, a random
`WORKOS_COOKIE_PASSWORD` of at least 32 characters, `WORKOS_ISSUER`,
`NEXT_PUBLIC_WORKOS_REDIRECT_URI` and `NEXT_PUBLIC_FINNOR_AUTH_PROVIDER=workos`.
The callback must be the registered, fixed `/api/auth/callback` on the application
origin. Use host-only cookies. Set the provider issuer explicitly; the standard
WorkOS issuer spellings are `https://api.workos.com,https://api.workos.com/`.

The API and every bearer-authenticating worker/SSE gateway require `FINNOR_AUTH_PROVIDER=workos`, `WORKOS_CLIENT_ID`,
`WORKOS_API_KEY`, `WORKOS_ISSUER` and `WORKOS_IDENTITY_BINDINGS`.
Never prefix secrets or identity bindings with `NEXT_PUBLIC_`. Production
environments reject test credentials. Switching an API to WorkOS disables its
Supabase token path; there is no automatic provider downgrade.

`WORKOS_IDENTITY_BINDINGS` is a server-owned JSON object keyed by WorkOS user ID:

```json
{
  "user_EXAMPLE": {
    "principalId": "00000000-0000-4000-8000-000000000001",
    "tenantId": "00000000-0000-4000-8000-000000000002",
    "loginEmail": "person@example.com",
    "canonicalEmail": "existing-account@example.com"
  }
}
```

These are placeholders, not provisioning instructions. An administrator must
explicitly approve the exact existing FINNOR account and tenant before linking.
The WorkOS user's external ID must equal that account's principal UUID. The
provider email must be verified and match `loginEmail`. The canonical database
lookup must still return the same principal and tenant, with active employee
status and current authority. No user, tenant or owner role is created by login.
WorkOS organization and role claims do not select FINNOR authorization.

The frontend uses the linked principal as its cache identity. Refresh responses
are bounded and sequenced; sign-out clears local identity and informs other tabs.
The SDK owns PKCE, callback verification and encrypted HttpOnly session cookies.
Logout first preserves the existing live-delivery tombstone, then uses the configured same-origin POST and a 303 redirect. WorkOS client, subject and session IDs derive a stable namespaced UUID for the existing delivery owner; token refresh retains it and a new login gets a distinct value. Credential-generation rejection and request deadlines are preserved from the production source.
Private session responses are never cacheable. Provider access-token expiry and
refresh revocation retain WorkOS's standard session semantics.

## Verification

Write the failure model before changing an isolated critical verifier. Run:

```sh
node scripts/auth/verify-workos-boundaries.mjs http://localhost:3000 /private/evidence/http
```

The tenant E2E driver requires an explicitly approved account-binding fixture,
TLS-verified application-role PostgreSQL access and a private evidence path:

```sh
npx tsx scripts/auth/verify-workos-tenant-e2e.mts /private/evidence/tenant.json /private/readonly-account-fixtures.json
```

The tenant driver runs the production authentication resolver through a controlled
HTTP server and real read-only PostgreSQL/RLS. Its identity-provider responses
and signing key are emulated. It is not a real WorkOS sign-in or mounted browser
qualification. Actual user sign-in/verification, refresh/logout, principal switch
and the deployed frontend/API must also be exercised before reporting live recovery.

Prepare both frontend and API configuration for the same WorkOS environment.
Stage and verify the matching source/configuration cut before coordinated cutover.
Preserve old configuration for rollback; never deploy unrelated dirty programme
work as part of an authentication repair. Staging and production WorkOS user IDs
are distinct, so recreate and verify the approved binding in each environment.

## Verification recorded on 2 November 2026

The release branch starts at the deployed release commit
`b13bc6e5409f5e33e973e6dbf6212d09a1b94df1`. It preserves that version's
deadline-aware identity lookup, credential-generation rejection and delivery
revocation owner. The older dirty development checkout is not the release source.

- PASS: 14 local Next HTTP cases using Next 16.4.1 and AuthKit 4.6.2.
- PASS: 18 controlled resolver HTTP cases with emulated WorkOS signatures/user
  responses and real, read-only application-role PostgreSQL/RLS. These include
  stable delivery identity across refresh and distinct identity across logins.
- PASS: scoped frontend/backend TypeScript programs, including their imported
  dependencies, and lint of the changed frontend and HTTP driver.
- NOT_DONE: a complete production build/cold installation and real mounted
  WorkOS sign-in, verification, authenticated refresh/logout and account switch.
  The local login-page HTTP smoke did not finish successfully.
- NOT_DONE: production identity linkage, coordinated frontend/API/any exposed SSE
  gateway configuration and deployment. Production credentials were pending.

These checks establish adapter boundaries; they do not establish live recovery.
Private evidence and the approved identity fixture stay outside the repository.
