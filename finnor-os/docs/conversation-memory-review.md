# Review of the conversation-memory repair

Base: f80266f8e50356e8537bc3d4a4475a601225fc1e. Reviewed head: d083761d45cca98d577b5cf3b44e644296606570. Independent Standards and Spec passes were requested explicitly by the user.

## Standards

## Standards

Reviewed `git diff f80266f8e50356e8537bc3d4a4475a601225fc1e...d083761d45cca98d577b5cf3b44e644296606570`, commits `6beb9f4` and `d083761`. Standards: AGENTS.md, TypeScript best practices and type-system discipline. Read-only review; no product edits or remote model calls.

**1 concrete boundary-discipline issue in the pinned head, corrected in the current working tree:** `conversation-memory.ts:283` treats any citation as sufficient to prevent the exact-source fallback. `conversation-prompt.ts:52–53` nevertheless excludes every `assistant_proposal` from mandatory reservation, including an item backed by an original user source. A fallible model classification can consequently turn accepted user evidence into optional material and silently evict its only retained representation when the prompt fills. The type-system/boundary standards require external classifications to be validated into a representation whose preservation rule cannot be contradicted downstream. Derive mandatory preservation from source ownership, independently of model kind.

The parent has applied that fix in the working tree: every user-backed item is mandatory. I executed the actual current prompt packer with a user-backed `assistant_proposal` containing a 3,928-character original quote and a declared 5,000-token context. It raised `ConversationContextCapacityError` instead of silently dropping the source. This is focused read-only runtime evidence, not the broader native E2E or a new independent release certification.

**Heuristic smells:** no additional blocking Fowler smell identified. The large compactor contains several stages, but splitting it without an observed failure would be a judgement-call refactor, not a standards blocker. Existing owner-only checks match the repository’s deliberate `Role = "owner"`; they are not reported as an employee-role regression.

**Standards total:** one pinned-head issue, addressed locally; zero further concrete blockers found in this bounded pass.

## Spec

## Spec

Reviewed pinned diff `f80266f8e50356e8537bc3d4a4475a601225fc1e...d083761d45cca98d577b5cf3b44e644296606570` (commits `6beb9f4`, `d083761`).

- **P1 — A valid burst can permanently stall compaction.** The spec requires bindings and compaction to “survive restart, concurrent input, retries” (failure model, rubric 5). `conversation-memory.ts:197–207` reads only 12 pending rows, then drops every trailing user row. Twelve user inputs before the first assistant response at sequence 13 make every old or new job reread the same 12 users and return `awaiting_complete_exchange`. The parent's working fix expands the read and stops only at an assistant boundary. Native DB probe now publishes through 13.

- **P1 — Supersession can discard unrelated facts from the prompt.** The spec requires repeated compaction to preserve “critical accepted task state and later corrections” (rubric 2), and preserve unrelated requirements. At `conversation-memory.ts:283`, a chunk gets no independent original-source context item whenever any extracted item cites it. If one original message contains payment 30 days and discount 12%, a payment-only extracted item holds the only active copy of both in its quote. A later 45-day correction supersedes that item; `conversation-prompt.ts` filters superseded items before packing. Native DB probe confirms the active checkpoint then contains 45 days but no 12%. This is an input-loss failure when retrieval lacks literal overlap. The parent's working fix adds a separately reserved archive of historical user quotes, including superseded-item originals; native readback confirms the final packed request includes both the unrelated 12% source and current 45-day constraint.

No additional concrete scope creep or missing native owner integration found. Mounted UI and production activation remain explicitly unqualified in the report; they are not hidden implementation claims. Finite live replay does not establish universal assistant parity.

**Summary:** 2 findings in the pinned Spec axis, both P1; concurrent-stall fix verified, source-archive fix verified by native checkpoint plus actual prompt readback.

## Fix dispositions

User-backed evidence is now mandatory regardless of a generated item kind. The compactor scans through a complete exchange beyond the nominal 12-row batch, so consecutive user turns cannot hide an already persisted assistant reply. Superseded items retain their original user quotes in a separate chronological prompt archive; correcting one fact cannot erase unrelated facts in the same source. Capacity overflow still fails explicitly.

CI fixture providers now declare their supported 131072-token capacity. Source stamps are regenerated before the planner replay manifest so image relocation checks compare the final emitted source cut. Existing E2E assertions are preserved.

Independent affected checks: native compactor advances through sequence13 after12 user messages; actual packed prompt retains both12% and45days after supersession. Standards probe verifies a user-backed assistant_proposal cannot be silently evicted; insufficient capacity is explicit.
