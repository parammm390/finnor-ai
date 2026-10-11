# R5 Work leaf failure model, registered before implementation

Owned base is sealed R4 `4a90ed33ca96afa252c51f511fea279e0034cddb`,
tree `310a43fa2b7983bf33afc321795461c9678ce7f9`. The independent leaf owns only
`CoalitionProgrammeReview.tsx`, `coalition-programme-view.ts` and this handoff
directory. The integrator's R5 backend is read-only. No publication, deployment,
live owner writes, browser interaction, shared edit or dependency installation
belongs to this assignment.

## Data shape and owner boundaries

- `CoalitionProgrammeView` validates the immutable native artifact for display.
  Exact quantities remain strings. No client valuation or financial ledger is
  introduced.
- `CoalitionSelectionView` is S4's immutable selected model-relative behaviour,
  not an admitted executable programme or party agreement.
- `CoalitionAllocationView` holds the original S5 point certificate and the
  canonical mutable reservation readback. Its finite point check is not a
  constrained-family optimality certificate.
- `CoalitionConsumptionView` is an intended pending S6 handoff, not actual
  external consumption. One deterministic request key binds the allocation.
- `CoalitionScheduleView` preserves S6's proposed observable-event payment
  schedule. Consent history is ordinary owner reporting with
  `acceptanceObserved:false`, not a signature, invitation or settlement.
- Private responses are scoped by parent scope, actual auth session generation,
  Work, root, optional current Work revision and immutable owner pointers.
  Request epochs, current session checks and visibility fence stale responses.
- URL state carries only the authenticated user/Work/root binding, reference
  digests and a same-request recovery marker. It carries no tokens, party
  preferences, report bodies, monetary values or private artifact JSON.

Existing entry points are `centropyPost`, `useCentropyAuth`,
`getCurrentSessionKey` and `onBusinessInvalidation`. Every refresh first
reauthorizes the Work/root through `company-brain/capital-program-context`.
It then uses `policies/coalition-read`, `allocations/coalition-read` and, when
available, `obligations/coalition-read` and `coalition-consent-history`.
There is no automatic write on mount, refresh, visibility restoration or reload.
Only explicit owner controls call `allocations/coalition-clear`,
`coalition-consume` and `obligations/coalition-prepare`.

## Observable failure cases and required oracles

| Case | Trigger and credible regression | Required observable result and strongest oracle |
| --- | --- | --- |
| F01 | Switch user, Work or root while an owner request is delayed. | Old private output disappears and delayed responses cannot restore it. Actual mounted authenticated Work plus delayed real HTTP response. |
| F02 | Rotate the bearer or temporarily revoke owner role. | All private output is hidden until current-session owner reads succeed. Mounted Work and backend auth logs. No token is retained in URL/evidence. |
| F03 | S5 commit invalidates the original M3 snapshot. | M3 stays INVALIDATED. Independently read S4/S5/S6 refs restore actual retained responsibility; no current M3 claim or patched null owner field. Real SQL/API readback and mounted Work. |
| F04 | Reload a URL containing current, foreign or malformed reference digests. | Only matching user/Work/root refs are sent to owners. Malformed current refs fail closed. Reload performs no writes. Mounted request trace and canonical owner identity. |
| F05 | Supply fractions, negative transfer legs, nonzero outside options or an absent bound. | Original strings and units/dates/funding/event witnesses remain exact. Missing values say unknown, not zero. Literal original API bytes compared with mounted text. |
| F06 | Double-click a control or lose a response after commit. | One stable clearance/consumption request identity is reused. No new consumption/effect is manufactured. Ambiguous response is not reported as rollback. Real S5 SQL origins and request digests. |
| F07 | History contains REPORTED_ACCEPTED, revised terms, decline, withdrawal or no response. | Ordinary reports remain ordinary. Independent acceptance/signature, admission and settlement are unobserved. Actual S6 history bytes and mounted labels. |
| F08 | Hide the page, pagehide, expire selection or change revision/dependencies. | Values clear immediately; stale reads are fenced. Refresh reauthorizes. Retained refs/responsibilities are not called released or cancelled. Mounted Work and canonical S5 readback. |
| F09 | Return a wrong ref, Work/root, candidate/checker join, reservation/certificate join or schedule/consumption join. | No mismatched value or next-stage command is exposed. Actual owner mutation/negative boundary, not a fixture receipt. |
| F10 | Disposable-profile or protected authority gate refuses a planning step. | Refusal is explicit; no admission, executable qualification, invitation or payment is asserted. Real owner refusal and mounted status. |
| F11 | A newer producer artifact differs from restored owner refs. | Old and new artifacts are not silently joined. Display only the matching independently reauthorized selection and label immutable producer gaps separately. Mounted Work with real immutable origins. |
| F12 | Large admitted option family or keyboard-only use. | Display limits are disclosed, selected programmes remain complete, controls have semantic buttons/status/details. Trusted mounted accessibility and actual full-family owner counts. |
| F13 | Client bundle accidentally imports backend/native machinery or view schema drifts from actual owner types. | Narrow TypeScript contract check rejects shape drift; client source imports remain frontend-only. Joined installed Next build is a separate gate. |
| F14 | S4 currentness fails after a retained S5 intention. | Current mathematical values are hidden. Authorized canonical S5/S6 responsibilities can still be shown explicitly as retained, never as settled or newly executable. Real owner readback after invalidation. |

No unit, mocked DOM or headless browser tests will be written after product
code. The cases above are the mounted verification contract for the serial
integrator, not a claim they ran. Existing signed bearer/SQL/worker/native and
owner evidence supplied by the parent is context, not new leaf evidence.

## Finite local verification

Run only narrow TypeScript owner-shape compilation, installed ESLint on the two
owned source files, TypeScript client transpilation/import-boundary inspection
and `git diff --check`. Reuse the integrator's lock-compatible installed
dependencies read-only. Maximum 180 seconds per compiler/lint command, 600
seconds per local campaign, 768 MiB JavaScript heap. Rerun only checks affected
by a concrete repair. No full Next build, install, database, worker, provider,
browser, fault, performance or economic run is authorized in this leaf.

A compile/transpile result is `DETERMINISTICALLY_VERIFIED` only for that static
source/dependency cut. Functional mounted behaviour, installed bundle,
full-family mathematical correctness, fault/reload and joined compatibility
remain `NOT RUN` unless the integrator supplies real qualified receipts.
