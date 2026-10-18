# Mounted identity acceptance addendum

This addendum precedes the local auth-fixture and browser-driver changes.
It does not change the application specification or authorization rules.

The existing signed local identity fixture supports password sign-in but does
not implement refresh-token exchange. That limits the old mounted proof, even
though the installed product uses the ordinary canonical auth consumer.

Extend only that disposable identity-provider fixture with bounded token
lifetime, random rotating refresh tokens, logout invalidation, and non-secret
operation counters. Keep its existing one-hour default and real HMAC verification.
No builder token, copied browser storage, production identity provider, protected
signer, or authority bypass may be introduced.

Required browser observations:

1. Password sign-in occurs through the actual login form.
2. With a real short token lifetime, the unmodified browser auth client performs
   an actual refresh exchange. Observe the provider's counter, not a forged
   client event or manually edited session. Drive the same installed application
   after its token changes, and retain canonical release/data identity.
3. Sign out through the actual account menu. The old application and forms must
   not survive into the signed-out or next-principal state.
4. A separately signed-in canonical partner opens an independently owned Work
   thread bound to the same authorized Work/root/application. The partner, not
   the analyst or a builder, closes a real evidenced record under its current
   scoped role. Inspect the actual persisted actor and business event.
5. Sign out and freshly sign in as the original analyst. Reload the same
   persisted record and release. Continue maintenance and the existing stale
   response, Work-switch, reload, and revocation campaign.

The provider's counters contain only counts. Never retain access/refresh tokens,
cookies, signing material, or authenticated browser storage.

Credible failures are a missing refresh protocol, a non-rotating or replayed
refresh token, invalid refresh acceptance after logout, old-principal state
resurrection, a partner denied by a missing authorized Work binding, a partner
acting as the analyst, and a client-only success without an actual SQL event.
The strongest owner boundary is the real emitted browser/API with ordinary
database roles; no post-code unit tests or test-only production exports are
needed.

These observations qualify only the disposable signed development identity
surface. They do not establish a hosted identity provider, independent protected
custody, production deployment, or new grants.
