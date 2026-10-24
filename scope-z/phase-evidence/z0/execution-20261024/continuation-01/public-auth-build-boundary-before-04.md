# Browser public Auth build boundary, recorded before edits

## Source diagnosis, not an executed native failure

The real `src/lib/centropy/supabase-browser.ts:10-11` reads literal
`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Its empty-input
path refuses browser authentication. Installed Next 16.4.1 documentation,
`dist/docs/01-app/02-guides/environment-variables.md:154-166`, explicitly says
these values freeze at build time and cannot be supplied later at server start.
The current clean reconstruction environment supplies neither value.

Therefore a successful unauthenticated engineering build cannot stand in for
an Auth-configured installation. No real public Auth input, native authority
or independent native fixture has been delivered. No fabricated input will be
used to produce a positive.

## Failure map and expected behavior

1. No explicit public build input: build the actual ordinary frontend, record
   `NOT_DELIVERED`, and leave authenticated/native qualification NOT_RUN.
2. Explicit missing, expired, foreign-session or wrong-source input: refuse
   before extraction, installs, listeners or authentication.
3. Inherited `.env`, arbitrary environment dump, service-role/secret key or
   user bearer: never copy it into a client. Accept only two named public
   values in an explicit source-bound declaration; require a loopback Auth
   origin and a publishable or anonymous-role provider key, not a user token.
4. Inject public values only into the actual Next build subprocess, not npm,
   native builds or offline doctors. Record names and digests, never values.
5. Installed native preflight: require the build receipt to bind the actual
   authorized Auth origin and public key. Metadata is not a real Auth positive;
   the existing actual login, `/me`, native owner and independent DB gates stay.
6. Preserve installation-07 and prior failures unchanged. After source changes,
   commit, freeze a fresh source archive and run a new full reconstruction.
7. Retain the full emitted installation manifest outside the generated runtime
   so a portable evidence handoff contains every asset, not just summary counts.

## Finite verification

Use syntax checks, the actual recipe's missing-explicit-input refusal, the
network-free driver doctor and missing-native-authority refusal, followed by
the actual fresh archive-only build/emission/closure recipe. These are workflow
checks, not post-code unit tests. Do not run native Auth, DB, queue, mounted
business flow or physical recovery without separately delivered authority.
