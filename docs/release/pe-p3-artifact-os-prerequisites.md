# P3 Artifact OS prerequisite report

Status: **BLOCKED_PREREQUISITES — P3 implementation not completed.**

The attached P3 specification requires verified, merged P1/P2 and explicitly requires a blocking regression report when either is absent. A fresh clone of current `main` lacks both new phase implementations. Local prerequisite repairs and regression verification are recorded below; these are not Artifact OS delivery.

## Starting identity

| Item | Observed value |
|---|---|
| Branch | `codex/p3-epistemic-runtime` |
| HEAD | `80f617d321965b8694de18940ff23b005dedcdb7` |
| Committed tree | `f38b551d99952986527e4986e3ba77891a3c10ef` (fresh `git cat-file -p HEAD`) |
| Local migration head | `0114_microsoft_subscription_current_scope.sql` |
| Fresh remote main | `35a31ac18267e4b0fcffd189e9b70bafe0d4f65c` |
| Fresh main tree | `1d688539cf205e8d5df1b58c28bd220b4def4d5f` |
| Fresh main migration head | `0109_atomic_water_runtime_retirement.sql` |
| Working-tree cleanliness | Unverified: Git status stalls; the committed tree is not a digest of the populated local working directory. |

Source hashes, package dependency graph, and pre-edit findings: [starting audit](evidence/P3-artifact-os/starting-audit.json).

## Blocking prerequisites

1. Fresh `main` has no P1 Strategy/Opportunity/InvestmentCase/Thesis/Assumption/Decision implementation, P1 temporal world code, or migrations `0110`/`0111`; searches for equivalent symbols also returned no matches. These implementations exist locally.
2. Fresh `main` has no P2 Microsoft provider package or migrations `0112`–`0114`. The local checkout has background ingestion, but lacks the P2 source/admin configuration API and dedicated mandatory 180-case certification. The old `phase2-private-equity-certification.md` describes a different phase and is not Microsoft P2 certification.
3. No live Office or delegated Excel certification was run. Their status is **NOT_RUN_PREREQUISITES**, not PASS. Credential availability was not established because there is no completed P3 provider implementation to certify.

## Repairs and verification

- Fixed P1's populated-upgrade test to require its two foundation migrations and verify every subsequent pending migration in order. Existing populated-history/no-hindsight assertions remain intact.
- Fixed P1 certification to verify the current migration head while still requiring the P1 foundation migration.
- Registered the Microsoft webhook's actual subscription-client-state verification in the route boundary inventory. Its separate integration tests exercise forged and cross-tenant notifications.
- Regenerated the authorization matrix to include the Microsoft webhook.
- Local targeted unit check: **15 passed** (11 Microsoft provider, 4 P1 world).
- Local integration check: **53 passed, 0 failed, 0 skipped** across 10 suites in a fresh, isolated PostgreSQL cluster. This includes all **19 existing Microsoft integration tests**, P1 world and populated upgrade, Source Truth, and prior PE execution/governance regressions. [Case-level results](evidence/P3-artifact-os/local-prerequisite-results.json).
- Full local P1 certification: **PASS — 51/51 cases, 114 migrations**, including **364 unit tests**, fresh migration, populated upgrade, RLS, tenant isolation, OpenAPI, Source Truth and governance regressions. [Updated P1 certificate](generated/pe-p1-world-truth-certification.json). This does not certify P1/P2 as merged on main.

The first local database attempt lacked the test application-role password; the isolated harness was corrected. Its other failure was the obsolete P1 migration assertion, repaired above. These failed attempts were not counted as successful certification.

## Ownership audit and P3 state

| Classification | Finding |
|---|---|
| EXISTS / REUSE | Core Document, Evidence/EvidenceVersion, Work, BusinessEvent, Authority, DecisionReceipt, Source Truth, durable jobs, auth profiles and memory. Local P1 roots and P2 observations have owners to reuse after prerequisites close. |
| PARTIAL | App-only provider transport handles JSON/text, not certified binary file replacement/read-back. PDF reference ingestion extracts text but has no immutable artifact/page-anchor model. Memory records Document IDs/content hashes, not immutable DocumentVersion identity. |
| WRONG for P3 | `recordDocumentContent` overwrites current bytes. The download endpoint always names files `.pdf`. P1 regression certification previously assumed migration `0111` would remain latest. |
| MISSING | P1/P2 on current main; local P2 administration/certification; P3 immutable versions, storage, branches, OOXML, format IRs, formula graph, anchors, bindings, lineage, patches/diffs, reviews/comments/templates, provider publication/concurrency/read-back, version-aware memory, jobs, workspace, Office corpus and 190-case certification. |
| DELETE | Nothing deleted. No competing ownership system introduced. |

Core Document remains the single canonical logical artifact identity. **This turn did not introduce DocumentVersions or semantic Office IR.** Historical byte immutability, Office fidelity, safe concurrent publication and provider verification cannot yet be claimed. No P3 feature packages, production migrations, runtime jobs, artifact APIs, new Office dependencies or AWS resources were added. No library selection or fidelity bake-off was claimed.

## Official Microsoft capability checks

Checked against stable Graph v1.0 documentation during this audit; these are provider facts, not FINNOR implementation claims.

| Capability | Verified documentation |
|---|---|
| File download | Application permissions supported. `/content` redirects to a short-lived preauthenticated URL; the download URL needs no bearer token. [Microsoft download documentation](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0). |
| File replacement | Ordinary file replacement supports application permissions. Sensitivity-protected replacement requires delegated context. Single-request upload limit is 250 MB; this is not a FINNOR memory limit. [Microsoft replacement documentation](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0). |
| Upload session / concurrency | The upload-session endpoint documents `If-Match` and 412 conflicts. App-only sensitivity restrictions also apply. This does not prove final-commit race behavior in FINNOR. [Microsoft upload-session documentation](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0). |
| Provider history | Retention and version creation depend on configuration and may be finite. [Microsoft versions documentation](https://learn.microsoft.com/en-us/graph/api/driveitem-list-versions?view=graph-rest-1.0). |
| Specific version bytes | Historical-version content download exists; current-version bytes use the ordinary content endpoint. [Microsoft version download documentation](https://learn.microsoft.com/en-us/graph/api/driveitemversion-get-contents?view=graph-rest-1.0). |
| Excel session | Delegated work/school `Files.ReadWrite`; no application permission. Session-creation 504 can be retried as documented. [Microsoft session documentation](https://learn.microsoft.com/en-us/graph/api/workbook-createsession?view=graph-rest-1.0). |
| Range/formula reads and writes | Delegated `Files.ReadWrite`, no application permissions. [Range read](https://learn.microsoft.com/en-us/graph/api/worksheet-range?view=graph-rest-1.0), [range update](https://learn.microsoft.com/en-us/graph/api/range-update?view=graph-rest-1.0). |
| Excel calculation | Delegated work/school `Files.ReadWrite`, no application permissions. Range-read and calculation pages list Global/US government support and exclude China. [Microsoft calculation documentation](https://learn.microsoft.com/en-us/graph/api/workbookapplication-calculate?view=graph-rest-1.0). |
| Selected permissions | Selected scopes support delegated/application modes and resource-specific write roles. They still require the actual resource grant and authorized token. [Microsoft Selected permissions](https://learn.microsoft.com/en-us/graph/permissions-selected-overview). |

## Handoff

P4 is **not ready**: it cannot consume a completed SpreadsheetIR from this checkout. Required next work is to finish and certify P2, land the existing P1/P2 implementation on main, re-audit that exact main revision, then implement and certify the requested P3 system. The full P3 design/implementation audit remains outstanding beyond this hard prerequisite gate.

## Final verification and changed files

The final P1 run passed on the local checkout. The remote main SHA was rechecked and remained `35a31ac18267e4b0fcffd189e9b70bafe0d4f65c`. Overall P3 remains **BLOCKED_PREREQUISITES**; no Artifact OS completion or live Microsoft success is asserted.

Material source/test changes in this turn:

- `finnor-os/scripts/release/run-pe-p1-world-truth-certification.ts`
- `finnor-os/tests/integration/private-equity-p1-upgrade.test.ts`
- `finnor-os/tests/unit/api-route-auth-boundary.test.ts`
- `finnor-os/docs/authz-matrix.md` (generated)

P1/P5 local certification reports were regenerated by the existing release architecture. This P3 prerequisite report and its two JSON evidence files were added. No old migration was edited. Both temporary test clusters were stopped by their runners.
