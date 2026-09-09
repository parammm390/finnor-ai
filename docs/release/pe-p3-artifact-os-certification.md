# PE Phase 3 Artifact OS certification

Generated: 2026-09-09T14:53:13.176Z

- Deterministic result: **PASS — 190/190**
- Live Microsoft Office result: **BLOCKED_EXTERNAL_OFFICE_CERTIFICATION**
- Overall result: **BLOCKED_EXTERNAL_OFFICE_CERTIFICATION**
- Migration: **124 through 0126_pe_underwriting_runtime.sql**

Core Document remains the single canonical logical artifact identity.

P3 introduced immutable DocumentVersions; existing source bytes are never overwritten as historical truth.

FINNOR owns semantic Office IR locally and does not depend on an LLM to understand workbook/document/deck structure.

Microsoft Excel calculation is used only as an authoritative external recalculation path when delegated user authorization exists; it is not FINNOR's P4 underwriting engine.

Microsoft provider success is never treated as completion until file read-back and semantic verification succeed.

Unsupported OOXML features are preserved and surfaced rather than silently removed.

No Artifact OS operation overwrites a concurrent provider edit without exact conflict detection.

No separate Document, Evidence, Work, Authority, Receipt, Source Truth or Event system was created.

No underwriting, IC, planner, autonomous workforce or AWS Artifact Compute phase was smuggled into P3.

FINNOR can open a real PE workbook/document/deck as a deterministic semantic work product, preserve exact lineage, make certified typed changes, and prove provider state through deterministic read-back verification. The real-tenant production claim remains governed by the separate live gate.

## Audit and architecture

- Starting baseline: codex/p3-epistemic-runtime, 80f617d321965b8694de18940ff23b005dedcdb7, tree f38b551d99952986527e4986e3ba77891a3c10ef, migration 0111_pe_world_truth.sql
- P1 prerequisite: PASS (51 cases)
- P2 prerequisite: deterministic PASS (179/179); live status BLOCKED-EXTERNAL-CERTIFICATION
- Core ownership: PASS — @finnor/data-platform remains the sole writable owner of canonical Document; no artifact or pe_artifact owner exists.
- Storage: document_version_contents provides a bounded postgres/external storage abstraction. P3 uses exact Postgres bytes and leaves the external backend for A3 without adding S3.
- Heads: Separate compare-and-swap current, provider, draft and published heads; only the head projection is mutable.
- Provider publication: Local draft persists first; existing Authority decides publish; exact provider base/eTag is checked; acknowledgement is followed by mandatory byte readback and semantic verification.
- Memory: Artifact chunks persist exact document_version_id; current retrieval excludes superseded-version chunks while explicit historical retrieval can request them.

## Verification commands

| Gate | Result | Tests | Duration | Evidence hash |
|---|---:|---:|---:|---|
| migrationBundle | PASS | — | 239 ms | 61ff99ec1cd774f2 |
| openapi | PASS | — | 1650 ms | 8ae48595faa67518 |
| typecheck | PASS | — | 23031 ms | e3b0c44298fc1c14 |
| authzMatrix | PASS | — | 320 ms | e3b0c44298fc1c14 |
| peBoundary | PASS | — | 1981 ms | 7688152d9356d36c |
| p3Unit | PASS | 65 | 8045 ms | 374489d23c405503 |
| fullUnit | PASS | 520 | 82074 ms | b528badc5e0d4289 |
| p3Integration | PASS | 13 | 4494 ms | fe3550788346b91e |
| p2Regression | PASS | 33 | 13141 ms | 3ea34a7ec23e371e |
| p1AndSourceTruthRegression | PASS | 17 | 7361 ms | 23bf1f34aa7559a2 |
| peGraphRegression | PASS | 24 | 17222 ms | f38949b5f0d8f56a |
| coreRegression | PASS | 41 | 12130 ms | 5b789800dbc03377 |

## Golden Office/PDF corpus

| Fixture | Kind | Bytes | IR bytes | Nodes | Parse |
|---|---:|---:|---:|---:|---:|
| lbo-style.xlsx | xlsx | 11742 | 75853 | 141 | 32 ms |
| feature-heavy.xlsx | xlsx | 19460 | 27758 | 58 | 8 ms |
| macro-preservation.xlsm | xlsm | 13796 | 3076 | 5 | 4 ms |
| investment-memo.docx | docx | 39301 | 45875 | 105 | 58 ms |
| tracked-changes.docx | docx | 36754 | 7611 | 16 | 50 ms |
| ic-style.pptx | pptx | 22815 | 23160 | 51 | 12 ms |
| feature-heavy.pptx | pptx | 105638 | 46697 | 101 | 35 ms |
| text-evidence.pdf | pdf | 2558 | 982 | 2 | 1333 ms |
| image-only-evidence.pdf | pdf | 29043 | 467 | 1 | 3 ms |
| office-features.xlsx | xlsx | 9150 | 7676 | 15 | 5 ms |
| office-formulas.xlsx | xlsx | 9571 | 5400 | 10 | 4 ms |
| office-document.docx | docx | 31773 | 3894 | 6 | 7 ms |
| office-header-footer.docx | docx | 18079 | 26971 | 35 | 11 ms |
| office-presentation.pptx | pptx | 37859 | 5235 | 4 | 6 ms |

Limits: {"bytes":10485760,"expandedBytes":67108864,"parts":4096,"xmlBytes":8388608,"xmlNodes":200000,"xmlDepth":128,"irBytes":16777216,"pdfPages":500,"ratio":1000,"parseMs":30000}. These limits bound memory/ZIP/XML/IR/page work; the corpus benchmark stayed within them.

## Mandatory deterministic ledger

| # | Case | Result | Evidence |
|---:|---|---:|---|
| 1 | Existing Document remains canonical. | PASS | commands.p3Integration, databaseInvariants, populatedUpgrade |
| 2 | No canonical artifact entity added. | PASS | commands.p3Integration, databaseInvariants, populatedUpgrade |
| 3 | Existing document bytes migrate to one baseline version. | PASS | commands.p3Integration, databaseInvariants, populatedUpgrade |
| 4 | Metadata-only Document remains valid. | PASS | commands.p3Integration, databaseInvariants, populatedUpgrade |
| 5 | Version content immutable. | PASS | commands.p3Integration, databaseInvariants, populatedUpgrade |
| 6 | New content creates new version. | PASS | commands.p3Integration, databaseInvariants, populatedUpgrade |
| 7 | Same exact retry does not duplicate version. | PASS | commands.p3Integration, databaseInvariants, populatedUpgrade |
| 8 | Parent/version lineage correct. | PASS | commands.p3Integration, databaseInvariants, populatedUpgrade |
| 9 | Version SHA-256 deterministic. | PASS | commands.p3Integration, databaseInvariants, populatedUpgrade |
| 10 | Current document API remains compatible. | PASS | commands.p3Integration, databaseInvariants, populatedUpgrade |
| 11 | XLSX served with correct media type/filename. | PASS | commands.p3Integration, databaseInvariants, populatedUpgrade |
| 12 | DOCX served correctly. | PASS | commands.p3Integration, databaseInvariants, populatedUpgrade |
| 13 | PPTX served correctly. | PASS | commands.p3Integration, databaseInvariants, populatedUpgrade |
| 14 | PDF served correctly. | PASS | commands.p3Integration, databaseInvariants, populatedUpgrade |
| 15 | ZIP bomb rejected. | PASS | commands.p3Unit, goldenCorpus |
| 16 | path traversal rejected. | PASS | commands.p3Unit, goldenCorpus |
| 17 | external entity rejected. | PASS | commands.p3Unit, goldenCorpus |
| 18 | remote external relationship not fetched. | PASS | commands.p3Unit, goldenCorpus |
| 19 | macro never executed. | PASS | commands.p3Unit, goldenCorpus |
| 20 | OLE never executed. | PASS | commands.p3Unit, goldenCorpus |
| 21 | unknown part preserved. | PASS | commands.p3Unit, goldenCorpus |
| 22 | malformed relationship rejected safely. | PASS | commands.p3Unit, goldenCorpus |
| 23 | real Office-generated XLSX parses. | PASS | commands.p3Unit, goldenCorpus |
| 24 | worksheet order preserved. | PASS | commands.p3Unit, goldenCorpus |
| 25 | cell values preserved. | PASS | commands.p3Unit, goldenCorpus |
| 26 | formulas preserved. | PASS | commands.p3Unit, goldenCorpus |
| 27 | cached values distinguished. | PASS | commands.p3Unit, goldenCorpus |
| 28 | named ranges parsed. | PASS | commands.p3Unit, goldenCorpus |
| 29 | tables parsed. | PASS | commands.p3Unit, goldenCorpus |
| 30 | charts discovered/preserved. | PASS | commands.p3Unit, goldenCorpus |
| 31 | merged cells preserved. | PASS | commands.p3Unit, goldenCorpus |
| 32 | styles preserved. | PASS | commands.p3Unit, goldenCorpus |
| 33 | number formats preserved. | PASS | commands.p3Unit, goldenCorpus |
| 34 | conditional formatting preserved if unsupported for editing. | PASS | commands.p3Unit, goldenCorpus |
| 35 | data validation preserved. | PASS | commands.p3Unit, goldenCorpus |
| 36 | comments/notes preserved. | PASS | commands.p3Unit, goldenCorpus |
| 37 | external links represented without fetching. | PASS | commands.p3Unit, goldenCorpus |
| 38 | hidden sheets preserved. | PASS | commands.p3Unit, goldenCorpus |
| 39 | no-op operation leaves source unchanged. | PASS | commands.p3Unit, goldenCorpus |
| 40 | target cell edit changes only intended package semantics. | PASS | commands.p3Unit, goldenCorpus |
| 41 | formula edit changes exact formula. | PASS | commands.p3Unit, goldenCorpus |
| 42 | untargeted package-part hashes unchanged. | PASS | commands.p3Unit, goldenCorpus |
| 43 | same-sheet dependency. | PASS | commands.p3Unit, goldenCorpus |
| 44 | cross-sheet dependency. | PASS | commands.p3Unit, goldenCorpus |
| 45 | range dependency. | PASS | commands.p3Unit, goldenCorpus |
| 46 | defined-name dependency. | PASS | commands.p3Unit, goldenCorpus |
| 47 | structured-table reference. | PASS | commands.p3Unit, goldenCorpus |
| 48 | external reference marked external. | PASS | commands.p3Unit, goldenCorpus |
| 49 | INDIRECT marked dynamic/partial. | PASS | commands.p3Unit, goldenCorpus |
| 50 | unsupported formula does not create guessed edges. | PASS | commands.p3Unit, goldenCorpus |
| 51 | circular dependency exposed. | PASS | commands.p3Unit, goldenCorpus |
| 52 | formula change invalidates dependent calculation status. | PASS | commands.p3Unit, goldenCorpus |
| 53 | VBA binary detected. | PASS | commands.p3Unit, goldenCorpus |
| 54 | VBA never executed. | PASS | commands.p3Unit, goldenCorpus |
| 55 | read path works to certified level. | PASS | commands.p3Unit, goldenCorpus |
| 56 | no-op preserves VBA hash. | PASS | commands.p3Unit, goldenCorpus |
| 57 | permitted non-VBA edit preserves VBA hash exactly. | PASS | commands.p3Unit, goldenCorpus |
| 58 | unsupported XLSM write fails rather than stripping macro. | PASS | commands.p3Unit, goldenCorpus |
| 59 | real Office DOCX parses. | PASS | commands.p3Unit, goldenCorpus |
| 60 | sections. | PASS | commands.p3Unit, goldenCorpus |
| 61 | paragraphs/runs. | PASS | commands.p3Unit, goldenCorpus |
| 62 | headings/styles. | PASS | commands.p3Unit, goldenCorpus |
| 63 | tables. | PASS | commands.p3Unit, goldenCorpus |
| 64 | headers/footers. | PASS | commands.p3Unit, goldenCorpus |
| 65 | footnotes/endnotes. | PASS | commands.p3Unit, goldenCorpus |
| 66 | comments. | PASS | commands.p3Unit, goldenCorpus |
| 67 | bookmarks/hyperlinks. | PASS | commands.p3Unit, goldenCorpus |
| 68 | tracked changes preserved. | PASS | commands.p3Unit, goldenCorpus |
| 69 | images preserved. | PASS | commands.p3Unit, goldenCorpus |
| 70 | supported text replacement. | PASS | commands.p3Unit, goldenCorpus |
| 71 | table-cell update. | PASS | commands.p3Unit, goldenCorpus |
| 72 | paragraph insertion. | PASS | commands.p3Unit, goldenCorpus |
| 73 | no-op fidelity. | PASS | commands.p3Unit, goldenCorpus |
| 74 | untargeted parts preserved. | PASS | commands.p3Unit, goldenCorpus |
| 75 | unsupported text-box target fails. | PASS | commands.p3Unit, goldenCorpus |
| 76 | real Office PPTX parses. | PASS | commands.p3Unit, goldenCorpus |
| 77 | slides stable. | PASS | commands.p3Unit, goldenCorpus |
| 78 | masters/layouts/themes preserved. | PASS | commands.p3Unit, goldenCorpus |
| 79 | shape IDs stable. | PASS | commands.p3Unit, goldenCorpus |
| 80 | text parsed. | PASS | commands.p3Unit, goldenCorpus |
| 81 | tables parsed. | PASS | commands.p3Unit, goldenCorpus |
| 82 | image refs parsed. | PASS | commands.p3Unit, goldenCorpus |
| 83 | notes parsed. | PASS | commands.p3Unit, goldenCorpus |
| 84 | charts discovered/preserved. | PASS | commands.p3Unit, goldenCorpus |
| 85 | grouped shape preserved. | PASS | commands.p3Unit, goldenCorpus |
| 86 | transition/animation parts preserved. | PASS | commands.p3Unit, goldenCorpus |
| 87 | exact text replacement. | PASS | commands.p3Unit, goldenCorpus |
| 88 | exact table-cell replacement. | PASS | commands.p3Unit, goldenCorpus |
| 89 | slide reorder. | PASS | commands.p3Unit, goldenCorpus |
| 90 | template slide creation. | PASS | commands.p3Unit, goldenCorpus |
| 91 | no-op fidelity. | PASS | commands.p3Unit, goldenCorpus |
| 92 | untargeted parts preserved. | PASS | commands.p3Unit, goldenCorpus |
| 93 | text PDF parsed with page anchors. | PASS | commands.p3Unit, goldenCorpus |
| 94 | exact page citation. | PASS | commands.p3Unit, goldenCorpus |
| 95 | image-only PDF reports text unavailable. | PASS | commands.p3Unit, goldenCorpus |
| 96 | no fake OCR. | PASS | commands.p3Unit, goldenCorpus |
| 97 | PDF remains read-only. | PASS | commands.p3Unit, goldenCorpus |
| 98 | version supersedes relation. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 99 | template instantiation lineage. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 100 | cross-Document derived_from lineage. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 101 | exact node→EvidenceVersion binding. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 102 | exact node→PE entity binding. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 103 | exact node→P1 Assumption binding. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 104 | binding pinned to version. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 105 | old version binding not rewritten by new version. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 106 | cross-tenant binding rejected. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 107 | comment pinned to exact version/anchor. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 108 | resolved comment preserved historically. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 109 | exact anchor remaps across safe edit. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 110 | ambiguous anchor becomes stale. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 111 | editorial review pins version. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 112 | editorial approval does not become execution authority. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 113 | patch precondition success. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 114 | stale base version fails. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 115 | stale target hash fails. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 116 | compound patch atomic. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 117 | failed patch creates zero version. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 118 | successful patch creates one immutable version. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 119 | semantic diff equals expected diff. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 120 | unsupported edit fails. | PASS | commands.p3Integration, commands.p3Unit, databaseInvariants |
| 121 | app-only file download. | PASS | commands.p3Unit, commands.p3Integration, liveOfficeCertification is a separate external gate |
| 122 | provider version metadata. | PASS | commands.p3Unit, commands.p3Integration, liveOfficeCertification is a separate external gate |
| 123 | specific provider version retrieval where available. | PASS | commands.p3Unit, commands.p3Integration, liveOfficeCertification is a separate external gate |
| 124 | app-only supported file replace. | PASS | commands.p3Unit, commands.p3Integration, liveOfficeCertification is a separate external gate |
| 125 | eTag precondition. | PASS | commands.p3Unit, commands.p3Integration, liveOfficeCertification is a separate external gate |
| 126 | 412 conflict. | PASS | commands.p3Unit, commands.p3Integration, liveOfficeCertification is a separate external gate |
| 127 | no blind overwrite. | PASS | commands.p3Unit, commands.p3Integration, liveOfficeCertification is a separate external gate |
| 128 | large-upload path where supported/configured. | PASS | commands.p3Unit, commands.p3Integration, liveOfficeCertification is a separate external gate |
| 129 | delegated file replace. | PASS | commands.p3Unit, commands.p3Integration, liveOfficeCertification is a separate external gate |
| 130 | sensitivity-label blocked app-only path. | PASS | commands.p3Unit, commands.p3Integration, liveOfficeCertification is a separate external gate |
| 131 | delegated path used only when authorized. | PASS | commands.p3Unit, commands.p3Integration, liveOfficeCertification is a separate external gate |
| 132 | employee-linked delegated profile. | PASS | commands.p3Unit, commands.p3Integration, liveOfficeCertification is a separate external gate |
| 133 | P2 app-only connection unaffected. | PASS | commands.p3Unit, commands.p3Integration, liveOfficeCertification is a separate external gate |
| 134 | workbook session created. | PASS | commands.p3Unit, commands.p3Integration, liveOfficeCertification is a separate external gate |
| 135 | range read. | PASS | commands.p3Unit, commands.p3Integration, liveOfficeCertification is a separate external gate |
| 136 | range write where used. | PASS | commands.p3Unit, commands.p3Integration, liveOfficeCertification is a separate external gate |
| 137 | calculation requested. | PASS | commands.p3Unit, commands.p3Integration, liveOfficeCertification is a separate external gate |
| 138 | required outputs read back. | PASS | commands.p3Unit, commands.p3Integration, liveOfficeCertification is a separate external gate |
| 139 | revoked token handled. | PASS | commands.p3Unit, commands.p3Integration, liveOfficeCertification is a separate external gate |
| 140 | no delegated profile → calculations marked stale rather than fabricated. | PASS | commands.p3Unit, commands.p3Integration, liveOfficeCertification is a separate external gate |
| 141 | local draft persists before publish. | PASS | commands.p3Integration, commands.p3Unit |
| 142 | provider base version checked. | PASS | commands.p3Integration, commands.p3Unit |
| 143 | write acknowledged. | PASS | commands.p3Integration, commands.p3Unit |
| 144 | acknowledgement alone not completion. | PASS | commands.p3Integration, commands.p3Unit |
| 145 | provider content read back. | PASS | commands.p3Integration, commands.p3Unit |
| 146 | read-back creates immutable version. | PASS | commands.p3Integration, commands.p3Unit |
| 147 | read-back semantic diff expected. | PASS | commands.p3Integration, commands.p3Unit |
| 148 | expected effect → VERIFIED. | PASS | commands.p3Integration, commands.p3Unit |
| 149 | unexpected semantic change → verification failure. | PASS | commands.p3Integration, commands.p3Unit |
| 150 | provider normalization explicitly classified. | PASS | commands.p3Integration, commands.p3Unit |
| 151 | P2 later sees write and converges idempotently. | PASS | commands.p3Integration, commands.p3Unit |
| 152 | no duplicate EvidenceVersion/business event. | PASS | commands.p3Integration, commands.p3Unit |
| 153 | remote edit after local base detected. | PASS | commands.p3Integration, commands.p3Unit |
| 154 | base/local/remote three-way diff. | PASS | commands.p3Integration, commands.p3Unit |
| 155 | disjoint exact edits may merge only if certified. | PASS | commands.p3Integration, commands.p3Unit |
| 156 | overlapping edits never auto-merge. | PASS | commands.p3Integration, commands.p3Unit |
| 157 | stale provider eTag never overwritten. | PASS | commands.p3Integration, commands.p3Unit |
| 158 | artifact-derived embedding records exact DocumentVersion. | PASS | commands.p3Integration, commands.fullUnit |
| 159 | current retrieval does not treat old-version chunk as current. | PASS | commands.p3Integration, commands.fullUnit |
| 160 | historical retrieval can request old version where architecture permits. | PASS | commands.p3Integration, commands.fullUnit |
| 161 | existing public-reference ingestion remains green. | PASS | commands.p3Integration, commands.fullUnit |
| 162 | authenticated user opens artifact workspace. | PASS | commands.p3Unit, commands.typecheck, commands.openapi |
| 163 | version timeline truthful. | PASS | commands.p3Unit, commands.typecheck, commands.openapi |
| 164 | provider/local head distinction visible. | PASS | commands.p3Unit, commands.typecheck, commands.openapi |
| 165 | spreadsheet formula inspector works. | PASS | commands.p3Unit, commands.typecheck, commands.openapi |
| 166 | dependency inspector works. | PASS | commands.p3Unit, commands.typecheck, commands.openapi |
| 167 | semantic diff works. | PASS | commands.p3Unit, commands.typecheck, commands.openapi |
| 168 | supported edit creates new draft. | PASS | commands.p3Unit, commands.typecheck, commands.openapi |
| 169 | publish status truthful. | PASS | commands.p3Unit, commands.typecheck, commands.openapi |
| 170 | conflict visible. | PASS | commands.p3Unit, commands.typecheck, commands.openapi |
| 171 | unverified calculation visible. | PASS | commands.p3Unit, commands.typecheck, commands.openapi |
| 172 | source/evidence binding visible. | PASS | commands.p3Unit, commands.typecheck, commands.openapi |
| 173 | no fake Office rendering. | PASS | commands.p3Unit, commands.typecheck, commands.openapi |
| 174 | P1 certification green. | PASS | p1Prerequisite, commands.p1AndSourceTruthRegression |
| 175 | P2 certification green. | PASS | p2Prerequisite, commands.p2Regression |
| 176 | Source Truth green. | PASS | commands.p1AndSourceTruthRegression |
| 177 | PE document links green. | PASS | commands.p1AndSourceTruthRegression, commands.p3Integration |
| 178 | Evidence green. | PASS | commands.coreRegression, commands.p3Integration |
| 179 | BusinessEvents green. | PASS | commands.coreRegression, commands.peGraphRegression |
| 180 | Work green. | PASS | commands.coreRegression |
| 181 | Authority green. | PASS | commands.coreRegression, commands.fullUnit |
| 182 | DecisionReceipt green. | PASS | commands.coreRegression, commands.fullUnit |
| 183 | document sharing green. | PASS | commands.coreRegression, commands.fullUnit |
| 184 | computer-task green. | PASS | commands.coreRegression, commands.fullUnit |
| 185 | reference corpus PDF ingestion green. | PASS | commands.coreRegression, commands.fullUnit |
| 186 | OpenAPI green. | PASS | commands.openapi, commands.typecheck |
| 187 | fresh DB migration green. | PASS | databaseInvariants |
| 188 | populated DB migration green. | PASS | populatedUpgrade |
| 189 | RLS green. | PASS | databaseInvariants.rlsTables, databaseInvariants.privileges |
| 190 | tenant isolation green. | PASS | databaseInvariants.tenantIsolation, commands.p3Integration |

## External gate and blockers

- BLOCKED_EXTERNAL_OFFICE_CERTIFICATION: no complete opt-in real Microsoft tenant/database/source/delegated-profile configuration was available. Deterministic implementation is complete; production must not claim live Office certification until this gate passes.
- VCS cleanliness is not certified because .vercelignore is a macOS dataless file that blocks Git index scans. The immutable starting HEAD and tree are preserved as the audit baseline.

P4 may consume SpreadsheetIR and exact ArtifactBindings directly. It must preserve immutable versions, exact anchors, formula/cached-value separation, provider read-back verification, and P1/P2 temporal truth.
