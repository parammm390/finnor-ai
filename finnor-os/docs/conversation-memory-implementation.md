# Conversation memory repair

Baseline: `f80266f8e50356e8537bc3d4a4475a601225fc1e`. Scope: authenticated CENTROPY Investigation chat, the answer and planner consumers, and native Work-input continuity through Objective restart and redirect. Production activation remains a separate qualification.

The [historical audit](conversation-memory-audit-2026-10-29.md) found that ordinary answers dropped the prepared transcript, planner prefix truncation could discard the latest correction, summary fields had no compactor, and Objective iterations did not reload the originating chat. The [research note](conversation-memory-research-2026-10-29.md) motivates preserving originals, incremental state, correction lineage, scoped retrieval and separate reading tests. It does not establish perfect retention or parity with another assistant.

## Implemented flow

```mermaid
flowchart LR
  A[Accepted user message] --> B[Immutable original in private thread]
  B --> C[Accepted sequence and native Work input]
  B --> D[Background compactor]
  D --> E[Server-owned exact citations]
  E --> F[Independent semantic review]
  F --> G[Append-only checkpoint with source digest]
  C --> H[Checkpoint + original tail + scoped source retrieval]
  G --> H
  H --> I[Budgeted answer or planner request]
  C --> J[Fresh Objective worker reload]
  J --> H
```

The DB owns original messages and immutable checkpoints. Publication checks the active owner under a row lock, private thread, contiguous range, original source digest, exact citations and prior-item retention before advancing the summary cursor. A stale publisher cannot overwrite a newer checkpoint. Corrections and user resolutions supersede earlier items explicitly; assistant proposals remain unverified claims.

The compactor seals complete exchanges in bounded batches. It asks the model for short source aliases and attaches exact original text on the server. Long messages use source chunks that preserve Unicode and numeric boundaries. When a short proposed statement adds a numeric literal absent from its cited text, the entire original cited text becomes the statement before semantic review. Relative dates therefore remain relative, with the source timestamp available for later interpretation. Oversized unsupported statements fail without publishing.

The server also preserves every original user source chunk omitted by extraction as a cited context item. Empty extraction therefore cannot erase the batch's user evidence. User-backed context items receive the same mandatory prompt reservation as extracted constraints. Exact duplicate copies of already retained items are ignored; immutable prior items are carried by the server. A mistaken assistant citation can be repaired only to an original user source that contains the complete proposed statement literally. Unsupported assistant claims remain rejected. These controls address observed failures where a fallible summarizer and reviewer both missed a correction.

User and assistant source arrays are separated for extraction. Groq GPT-OSS compaction calls explicitly request low reasoning effort within the existing output/deadline bounds, after a live response exhausted its output allowance before completing the requested JSON. This adapter option applies only to the supported model IDs; other adapters retain their existing behaviour. See the primary [Groq reasoning documentation](https://console.groq.com/docs/reasoning). This does not make model interpretation infallible.

One prompt packer supplies conversation evidence to ordinary answers and both Objective planners. It reserves current instructions, canonical state, active constraints, the newest exchange, output and framing before adding whole historical messages. Capacity comes from supported model identities or an explicit configured declaration. Only configured providers with adequate capacity remain eligible; governance, observability and request deadlines survive that selection. UTF-8 byte counting is a conservative text-token upper bound, not a tokenizer measurement.

Retrieval searches original private messages through the accepted sequence and can expand recall terms with the configured classification model. Expansion failure falls back to lexical retrieval with a degraded diagnostic. This is lexical/model-expanded retrieval. It does not introduce a vector store or make a claim about arbitrary multi-session recall.

The native Work input binds its exact source message. Fresh Objective workers and redirects reload that cut; later chat cannot rewrite accepted context or lend a future contact/action target to an earlier request. Historical claims confer no execution authority. Canonical business reads retain their existing route; requests to finish or share earlier work remain actionable requests.

## Verification and limits

The [failure model](conversation-memory-failure-model.md) preceded implementation. The [verification plan](../scripts/memory/verification-plan.json) names the requirements, finite limits and rerun commands. Drivers use disposable native Postgres, actual API handlers and queue workers. Capturing providers prove delivery and persistence only. Real-model interpretation is evaluated separately.

| Requirement | Decisive evidence | Current status |
| --- | --- | --- |
| Ordinary answers receive previous sources | Actual `/api/actions` model-input capture | Passed |
| 30 user exchanges and replies persist | 60 original messages; all notes reach answer requests | Passed with deterministic transport |
| Repeated compaction retains corrections | At least three checkpoint publications and final corrected source | Passed with deterministic transport and recorded live-model replay |
| Reload and private isolation | Actual thread GET, other-owner/tenant rejection, checkpoint scope | API passed; mounted browser reload unverified |
| Concurrent requests exclude future turns | Actual accepted cuts and captured prompts | Passed |
| Restart/retry preserves memory | Physical worker SIGKILL before publication and before acknowledgement | Passed |
| Objective restart and redirect retain their cut | Fresh native queue worker, canonical and compatibility paths | Passed |
| Revocation fences publication | Lock real principal row, revoke, observe refusal | Passed |
| Model budget is explicit | 32k whole-request bound, undersized fallback excluded, unknown/overflow refused | Passed |
| Long messages preserve exact provenance | 19,538-byte exchange, number spanning naive chunk boundary, checkpoint readback | Passed |
| Relative dates and invented numbers stay source-backed | Published source wording and original timestamp, injected 99 absent | Passed with deterministic transport |
| Empty extraction cannot drop original user evidence | Empty producer result, native checkpoint readback, both original sources in a budgeted request | Passed with native checkpoint and model-input readback |
| Reading, corrections, paraphrase, unknowns, dates and financial synthesis | Real-model 30-exchange scenario and strict final JSON oracles | All five live checks passed on the recorded source cuts; prior failures retained |
| Existing behaviour and release metadata remain valid | 29 existing tests, typecheck, API build, registry/domain checks | Passed on recorded cuts; API build passed; final pure TypeScript source guards also typechecked |
| Production activation | Protected main release, migration and API/worker parity | Not performed |

Raw local evidence lives in ignored `memory-evidence/`; it includes prompts, source hashes, results, worker PIDs, checkpoint lineage and rerun instructions. Do not publish credentials, browser authentication state or production environment files. The committed [evidence index](conversation-memory-evidence.json) records raw artifact hashes, source cuts and qualification limits.

The live scenario includes 30 user exchanges, an early 30-day term corrected to 45, USD rather than EUR, exact artifact identity, multiple financial inputs, a topic detour, unknown churn, unverified email status and a relative deadline. Failed runs are retained. Resume mode restores exact recorded source IDs, sequences, text, timestamps and checked checkpoint state into a fresh disposable scope. Its lineage explicitly separates restored real exchanges from new ones; it does not restore or qualify old Work bindings.

## Operation and activation

Apply `postx_y6_conversation_memory.sql` through the native migration owner before activating API and BACKGROUND worker code. The new partial unique index requires no duplicate user source rows for one Work input; production compatibility must inspect existing data before release. No production migration or deployment was performed from this repair session.

Defaults retain eight exact messages and schedule compaction at an 18,000-byte conservative text-token upper bound. `FINNOR_MEMORY_EXACT_TAIL_MESSAGES` and `FINNOR_MEMORY_COMPACTION_TRIGGER_TOKENS` configure those bounds. `FINNOR_LLM_CONTEXT_WINDOWS` declares exact model identity capacities; known ceilings can only be reduced. Missing capacity fails explicitly.

Production release remains governed by `.github/workflows/production-release.yml`, canonical topology, protected secrets, exact-commit certifications and `production-mutation-guard.mjs`. Local AWS credentials were expired and the available local DB URLs did not match the canonical production DB host; no alternate target was used. Vercel readback confirms the baseline still serves production. Browser control was disabled in Work settings during final mounted verification, so no mounted reload success is claimed.

This repair does not qualify financial business truth, external action execution, provider availability in every deployment, unlimited conversation length, perfect semantic completeness or ChatGPT/Claude parity. It makes retained source evidence available and checks the named behaviours against a finite recorded corpus.

The successful live replay used the recorded 30 real API/model exchanges across restarts and quota-driven provider fallback. The first 29 replies used 120B and the final reply and reading checks used 20B. Three checkpoint states span sequences 1–12, 13–24 and 25–36. The final reading returned 45 days, USD, 12%, 1,200,000 revenue, 360-day basis, 60% gross margin, 20% EBITDA margin, the exact artifact ID and 150,000 working capital; unknown churn remained null and email verification false. Paraphrase recall and the original UTC-relative deadline passed. The final stronger mandatory reservation of user-backed context has an additional native 32k E2E proof; the evidence index retains the distinct source cuts.
