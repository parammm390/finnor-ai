# Mounted Work fixture: pre-code failure and acceptance contract

## Integrated execution follow-through

The source-only authoring restrictions below describe the original delegated
draft. The main driver subsequently adopted those bytes and owns isolated
runtime execution under the user's existing engineering authority.

Native 064 cannot create a page through the assigned desktop connection:
`Target.createTarget` is blocked. An empty new context is not a usable-page
proof. Do not take over a pre-existing page, reuse saved authentication, alter
desktop policy, or silently switch to headless execution. An explicit
`FINNOR_X2_MOUNTED_BROWSER=task_owned_visible_chrome` variant may launch a
separate visible system Chrome with a fresh temporary profile/context and no
saved authentication. A blank-page creation/close probe must succeed before
the maintained proof begins. Record the selected mode and browser version and
close only that task-owned browser. This proves a visible external browser,
not the Factory desktop pane.

Native 069 creates the visible isolated browser, rejects the wrong password,
signs in correctly, opens the actual persisted Investigation and observes its
exact canonical Work/session/principal/root panel. Its first independent SQL
callback then fails: the fixture selected nonexistent `works.user_id` rather
than canonical `created_by`/`current_owner_id`. Correct the fixture to assert
both real owner columns. Preserve 069 as failed, not a mounted pass, and retain
safe SQLSTATE-only diagnostics for future callback failures. No product
behavior, API authentication, business assertion or acceptance gate changes.

Native 070 passes login/canonical mounting and persisted focus/reload, then
times out during WORLD navigation while the frontend reports ENOSPC. Native
071 repeats the unchanged installation after the host has 7.5 GiB free. Its
same first two stages pass; WORLD, explicit no-context and Canvas navigation
complete, but the root-boundary stage fails before its final assertion.
The screenshot shows the rootless application panel removed. This does not
establish the complete root-boundary gate or a product fault.

Before changing the observer, investigate one concrete fixture failure mode:
tsx's name-preserving transform can insert an out-of-scope `__name` helper
into a callback serialized by Playwright. A fresh visible blank-page probe
must use the installed compiler and browser, preserve the named-arrow failure
and check an object-method candidate without adding a global helper,
replacing product globals or disabling CSP. Record unexpected outcomes as
unreproduced, not as permission to change acceptance. This is an isolated
browser-fixture diagnostic, never maintained application acceptance.

The isolated probe reproduces `__name is not defined` for the named arrow
under the installed tsx transform, Node 22.22.3 and visible Chrome
155.0.8059.41. The object-method candidate returns the expected DOM result.
`mounted-observer-probe-001.json` retains both outcomes and the original
observer-source hash. Replace only the observer's named arrow and finish
arrow with object methods; preserve every scope check, observation bound,
overflow refusal and assertion. No helper is installed on the product window.
The full mounted gate must still pass in a new frozen installation.

Written before implementation. This directory is the only write target. The FINNOR checkout is read-only; no server, browser, database, worker, build, credential discovery, publication or peer operation is authorized here.

## Authoring gate

1. Observable contract: a real maintained Investigation Canvas, supplied with canonical activeWorkId and a supported persisted Deal root, must display only the current canonical Work/session/status/tenant/principal. Real forms must reach the installed API and real worker; only independent canonical SQL and external-state callbacks may establish registration or business outcomes. Signed disposable authentication must actually validate passwords, signatures, expiry, live sessions, rotating single-use refresh credentials and global logout.
2. Credible regressions: unsupported frontend root; query-only Work selection; a synthetic route replacing the maintained mount; stale principal/root/Work caches; private inputs surviving offline/auth/access changes; malformed SDK session responses; unsigned, non-expiring or reusable credentials; global logout not revoking refresh families; a delayed authenticated response restoring old records; a callback selected Work incorrectly claimed to persist through reload; a toast or planned state substituted for an external result.
3. Missing coverage: parent-supplied completed source/native proof does not run the maintained browser and cannot observe real SDK refresh, navigation, focus persistence, connectivity, auth changes or intercepted response order. These modules add that boundary only; they do not repeat native acquisition algorithms, launch packaging, seed ownership or worker tests.
4. Production seams: none. No product changes, test-only product routes, copied API handlers, fabricated product payloads, SDK replacement, auth bypass, localStorage token injection or CSP relaxation. Playwright receives a fresh task-owned context from the caller. Only actual upstream response delivery may be delayed.

## Fixture failures to protect against

- Missing/duplicate/noncanonical identity references. Caller must supply two distinct genuine active canonical owner IDs and their synthetic canonical emails/passwords; native assertions own that fact. JWT role is `authenticated`, never a fabricated native owner grant.
- Foreign Origin, wildcard CORS, unsupported preflight method/header, wrong API key, oversized/invalid JSON, wrong method/path/grant, wrong password, refresh request carrying a password, unknown/expired/consumed refresh token, tampered/expired/wrong-issuer access token, dead session, global logout replay and post-close use.
- Session responses incompatible with installed frontend auth-js 2.99.3 or backend 2.115.0. Both accept a flat token response with access_token, refresh_token, token_type, positive expires_in, expires_at and user; /user returns the user object. Backend HS256 getClaims falls back to /user, not JWKS.
- Same-second token reuse. Every issuance has a distinct signed nonce. Refresh rotates an opaque one-use credential and generation in its password-login family; global logout revokes all of that user's families. A subsequent password login starts a fresh live family.
- Expiry must use real wall time. A caller may shorten the next password access-token lifetime; refresh tokens and subsequent access tokens retain independent bounded lifetimes. Browser proof must observe genuine SDK refresh and a formerly issued access token rejected after its real exp, without editing product clocks/storage.
- Secret leakage: no HTTP control endpoint, logging, HAR, tracing, raw browser storage, request headers, password/token/key serialization or ambient environment access. Keys/passwords remain in private caller-owned memory; returned token handles are opaque. Evidence contains only synthetic identifiers, redacted observations, response hashes and screenshots beneath the caller-owned evidence directory.

## Mounted acceptance and finite failure evidence

- Caller owns frontend/API/worker launch, all canonical Deal/Work/Investigation seeding, canonical status expectations, independent SQL/external assertions and cleanup. Invoke before those resources are cleaned up.
- Caller supplies a persisted acquisition Investigation, a separately persisted fresh Investigation linked to the distinct fresh Work, and a second principal's persisted Investigation. The initial acquisition parent must be usable; the fresh Work must be empty before the one explicit fresh-use submission. Optional acquisition inputs may be supplied when the initial Work has no sessions.
- Use Email, Password and Sign in; reject an intentionally wrong synthetic password before correct sign-in. Navigate with Investigations, Open WORLD, Choose WORLD root, Open Canvas and actual Canvas focus/save controls.
- Match data-application-work/session/status plus rendered canonical tenant/principal/root, then require throwing independent SQL assertion callbacks. Save and reload actual Canvas focus via real PUT/GET thread canvas; reload must restore persisted Work, never query workId.
- Change root from the real Deal to explicitly no context and back through real controls. The no-root Canvas must not mount private application evidence. This proves a root/no-root boundary, not a second Deal that was never seeded.
- Submit actual fresh-use form fields once; settle canonical registration and external business expectations through caller callbacks. Open recorded fresh Work through the actual in-memory callback, then use its separately persisted Investigation and perform a real reload. Never claim the source Investigation's activeWorkId changed.
- Hold a real successful application-projection response, switch Work using Investigations, then release the unmodified response only after the destination is canonical. Record actual delivery versus product cancellation; neither may resurrect the previous Work or private values.
- Real browser offline/reconnect must erase private evidence/inputs and require a new authenticated canonical read. Real token expiry, SDK refresh, genuine global logout and a fresh password sign-in must have independently observed auth/session transitions and new signed API traffic.
- Canonical revocation uses the caller's actual SQL/access-owner callback, not an auth fixture payload. While /user remains valid, a new real /me read must deny access and old private evidence must remain cleared after a pre-revocation response is released. Always restore task-owned revocation in finally before parent cleanup.
- Principal switch uses genuine logout and the second user's Email/Password sign-in. Hold the first principal's real recent-Investigations response, wait for the second principal's own list and selected Canvas, release the old response, and reject any first-principal-only Investigation title. This specifically exposes the known unfenced recent-list request rather than silently tolerating it.
- Network observations must include real successful /me, threads/detail/canvas, works/detail, Company Brain roots/projection/application, thread-canvas PUT and prefs. No API route is served by these modules.
- Every wait and delayed delivery is bounded. A premature timeout/release, uncaptured response, incorrect negative control, cancelled recent-list delivery, missing canonical callback or evidence overflow fails closed. Negative non-resurrection checks report their finite observation window, not universal absence.
- Every attempted run writes a private replayable JSON result with synthetic inputs, stage outcomes, safe network/auth observations, exact delay order/hash, canonical/external evidence references, screenshot paths, runtime qualification and unexecuted stages. Failures never become passes because a stack or callback was unavailable.

## Source-only validation allowed here

Read root AGENTS, retained OpenClaw test-audit skill, installed Next.js guides, actual product controls, installed Playwright 1.61.1 types and both installed auth-js implementations before relying on them. Type-check only these source modules with the installed compiler; record the exact command/result. No post-code unit tests or live execution.

## Known qualification and integration risks

- Current use-canvas-sources cache key lacks principal; current recent-Investigations request lacks a stale-response fence. The browser driver must expose, not repair or conceal, those risks.
- Loopback HTTP auth is allowed by maintained CSP only in development. A production frontend requires caller-supplied trusted HTTPS auth; development frontend plus emitted production-Node API/worker must be labelled accurately.
- Source-only validation cannot establish any mounted browser, HTTP-server, SDK-runtime, worker, SQL or external-business outcome. Main must review/adopt serially and run the integrated maintained proof.
