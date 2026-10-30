# Conversation memory: pre-implementation failure model

Recorded before implementation on 29 October 2026 against baseline f80266f8e50356e8537bc3d4a4475a601225fc1e. Phase checkboxes and preliminary checkout logistics are omitted here; the implementation report records current results.

## Design rubric

1. Every conversation-aware responder/planner consumes a common source-backed context; no route can silently erase it.
2. Original source remains recoverable; repeated compaction preserves critical accepted task state and later corrections with message provenance.
3. Context fits a declared model budget without cutting newest messages or mandatory authority/current business state; overflow and missing evidence are explicit.
4. Scoped retrieval resolves paraphrases, exact identifiers and temporal references while preserving employee/tenant isolation.
5. Compaction and Objective input bindings survive restart, concurrent input, retries and stale writer attempts without silently changing running authority.
6. Fits existing DB, Work, queue, provider and UI owners with a small public interface and decisive observable E2E proofs.

## Failure model (before new isolated test/implementation code)

Missing thread; discarded route context; sequence gaps; stale summary; summary hallucination or omitted constraint; summary-of-summary drift; overwritten correction; fabricated verified action; arbitrary truncation of recent messages/mandatory fields; unsupported model budget; oversized individual message; ungrounded retrieval and cross-person disclosure; retrieval outage; Redis expiry; compactor/provider failure; concurrent/double compaction; request seeing future concurrent turns; Objective restart losing accepted context; unrelated later chat rewriting active work; revoked owner; checkpoint/schema migration/restart incompatibility; tests bypassing real handler or checking only labels.

## Verification requirements

Register concrete commands and finite named cases in the chosen checkout before costly runs. Prefer actual authenticated HTTP and DB/queue/worker flow, with mounted readback where affected. Include 30 user exchanges plus replies, early/middle constraints, late correction, topic switch, exact artifact ID, paraphrase, temporal reference, multi-message synthesis, false premise, attempted versus verified actions, forced repeated compaction, reload/restart, duplicate/concurrent compaction and tenant/employee isolation. Record original inputs, expected facts, actual model requests, checkpoint versions/source coverage, answers/actions, process/DB evidence and rerun command. A capturing provider proves transport only; it cannot establish language-model comprehension. Real model tests are a separate required quality gate when an existing secure provider is available. No universal perfect-retention claim follows from a finite corpus.

## Follow-up failure: source citation and derived numbers

Live evaluations exposed model-normalized punctuation in copied quotes and a synthesized calendar date derived from tomorrow. Source citations now select immutable server-owned chunks. Unsupported numeric additions in a short statement are replaced by the complete cited source text before independent review; long unsupported statements fail explicitly. A chunk boundary must preserve numeric lexemes and Unicode surrogate pairs. No source update, relaxed exact-quote validator or invented date is permitted.
