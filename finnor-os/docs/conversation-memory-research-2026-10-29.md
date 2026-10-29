# Conversation memory and compaction: research evidence

Research date: 29 October 2026. Scope: retention and correct use of information in task-oriented assistant chats spanning 20–30 or more messages, including retrieval and repeated compaction. This note records primary literature and first-party engineering guidance. It does not establish what FINNOR currently implements or which runtime checks it has passed.

The evidence supports evaluating memory as several separate capabilities: preserving source information, finding the relevant evidence, resolving changes over time, and using that evidence correctly in the next action or answer. None of the sources below establishes a universal failure threshold at 20 or 30 messages, or guarantees perfect retention. A message count is also different from a token count or a user–assistant turn count.

## What the sources establish

### 1. LongMemEval: retrieval success and answer correctness are different

LongMemEval contains 500 curated questions covering extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention. In its experiments, decomposing sessions into rounds helps some readers; replacing original material with summaries or extracted facts can lose details and reduce overall QA performance. Facts help its multi-session reasoning subset. Original text augmented with extracted indexing information improves retrieval in the tested setup. Even perfect evidence recall does not ensure correct reading. These are model-, budget-, and benchmark-dependent results, rather than a universal storage prescription. [LongMemEval, ICLR 2025, §§3–5](https://arxiv.org/html/2410.10813).

**Audit implication:** separately check whether the source evidence survives, whether it reaches the model, and whether the final response follows it. Test updates, time references, and unknown answers explicitly. The paper's indexing experiments often use user-side utterances; that does not establish that assistant decisions or tool evidence can be discarded in FINNOR. [LongMemEval, §5.1 and Appendix D](https://arxiv.org/html/2410.10813).

### 2. LoCoMo: a longer transcript alone does not solve conversational memory

LoCoMo uses conversations averaging approximately 600 turns and 16,000 tokens across up to 32 sessions. They are generated from personas and temporal event graphs, then checked and edited by people. Evaluation includes QA, event summarization, and multimodal dialogue generation. Long-context models and RAG improve some results, while temporal and causal understanding remain difficult. This is predominantly open-domain, multi-session conversation, rather than a direct test of a 30-message business workflow. [Maharana et al., ACL 2024](https://aclanthology.org/2024.acl-long.747/).

**Audit implication:** remembering an isolated fact is insufficient evidence that a system retains an evolving task. Check relationships among events, decisions, dependencies, and changes as well as direct recall.

### 3. Lost in the Middle: position affects usable context

On multi-document QA and key–value retrieval, the tested models often perform better when relevant information appears near the beginning or end than in the middle. The experiment demonstrates position sensitivity in those models and tasks, including models marketed for long contexts. It does not establish the same effect size for a current FINNOR model, or a fixed maximum safe context length. [Liu et al., TACL 2024](https://aclanthology.org/2024.tacl-1.9/).

**Audit implication:** move otherwise identical critical instructions between early, middle, and late positions. A single successful placement cannot establish reliable long-chat retention.

### 4. RULER and NoLiMa: easy exact-match recall can overstate memory quality

RULER extends simple needle retrieval with multiple needles, multi-hop tracing, aggregation, and QA under distracting context. Its tested models degrade on more complex tasks despite strong simple needle results. It is a controlled synthetic benchmark. [Hsieh et al., RULER, 2024, §§2–4](https://arxiv.org/html/2404.06654).

NoLiMa reduces literal overlap between a question and its evidence. Its main study evaluates 13 models and reports that 11 fall below half their short-context baseline at 32K tokens. This is evidence about the benchmark and models tested, not a forecast for FINNOR or proof that 32K is a general limit. [Modarressi et al., ICML 2025, v3, §§3–4](https://arxiv.org/html/2502.05167v3).

**Audit implication:** include paraphrased references, related distractors, multi-fact questions, and evidence requiring more than one source message. An exact ID lookup and a broad task-state question exercise different capabilities.

### 5. LLMs Get Lost in Multi-Turn Conversation: history can preserve an early mistake

The authors compare fully specified prompts with simulated conversations that reveal requirements incrementally. Across six generation tasks, tested models show an average 39% performance degradation in the multi-turn setting. Early answer attempts can introduce assumptions that persist. The simulations are controlled, predominantly English analytical tasks; the result is not a 39% degradation per chat, a 20-message cutoff, or a measurement of memory loss alone. An additional decomposable translation task does not show the same degradation. [Laban et al., ICLR 2026, §§3–7](https://arxiv.org/html/2505.06120).

**Audit implication:** include a later correction that invalidates an earlier proposed solution, then evaluate the actual final artifact or answer. Repeating the earlier proposal faithfully would be a failure of current task state, even if the transcript was retained.

### 6. ACE: repeated whole-context rewriting can lose accumulated detail

ACE documents a context-collapse case in AppWorld adaptation: a complete context rewrite drastically shortens accumulated material and accompanies a performance drop. Its method uses localized updates to a structured playbook and is evaluated on agent and domain benchmarks. This is relevant evidence that repeated rewriting can erase useful information; it is not a controlled comparison of every conversational compaction policy, and its playbook is not a conversation transcript. The paper's preservation language is not a guarantee of perfect recall. [Zhang et al., Agentic Context Engineering, §§2.2–3](https://arxiv.org/html/2510.04618).

**Audit implication:** inspect information survival after multiple compactions, rather than qualifying only the first summary. Identify whether omissions or distortions compound between checkpoints.

### 7. Summary faithfulness requires more than fluent prose

FRANK introduces a factual-error taxonomy and human annotations for generated CNN/DailyMail and XSum summaries. It demonstrates that different factuality metrics have different strengths and weaknesses. Its evidence concerns news summarization, not assistant task state. [Pagnoni et al., NAACL 2021](https://aclanthology.org/2021.naacl-main.383/).

QAFactEval compares QA-based and entailment-based consistency evaluation. Question generation and answerability components materially affect metric performance; the approaches can provide complementary signals. Its benchmark results do not make either evaluator an infallible judge. [Fabbri et al., NAACL 2022](https://aclanthology.org/2022.naacl-main.187/).

**Audit implication:** assess both unsupported statements and omitted required information against source messages. A short, well-written summary may be faithful to what it includes while still omitting a decisive constraint. Similarity to a reference summary is insufficient to establish complete, correct task retention.

### 8. First-party engineering guidance describes useful checks, not guarantees

Anthropic describes compaction and persistent notes in its deployed agent work. It warns that aggressive compaction can lose subtle details and advises tuning on complex traces, starting with recall before removing excess material. This is first-party engineering experience, not a published controlled retention benchmark. [Anthropic Applied AI, Effective context engineering for AI agents, compaction section](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents).

OpenAI's session-memory cookbook distinguishes the abrupt information loss of last-N trimming from the distortion and compounding-error risk of generated summaries. It also notes that a few recent turns can still contain large payloads, and describes logging summaries for debugging and evaluation. Its examples do not certify any particular application. [OpenAI, Context Engineering: Short-Term Memory Management with Sessions](https://developers.openai.com/cookbook/examples/agents_sdk/session_memory).

**Audit implication:** record actual model input and compaction output. A database row, configured turn limit, or summary prompt does not establish which information the model actually received.

### 9. Long-horizon artifact fidelity is distinct from recall

DELEGATE-52 tests chained document transformations and inversions across 52 domains. The authors find that semantic content can degrade over extended interactions. Their subsequent clarification stresses that this is a diagnostic stress test, not a measure of overall task success or user satisfaction; its simplified tool harness does not represent every production system. [Laban et al., LLMs Corrupt Your Documents When You Delegate, 2026](https://arxiv.org/abs/2604.15597), [authors' methodological clarification, 15 May 2026](https://www.microsoft.com/en-us/research/blog/further-notes-on-our-recent-research-on-ai-delegation-and-long-horizon-reliability/).

**Audit implication:** a response that correctly recites requirements is weaker evidence than a resulting artifact that satisfies those requirements and preserves required content. Artifact verification must remain a separate check.

## Retention criteria for this FINNOR audit

The following are application-specific audit criteria inferred from the evidence above. They are not findings that FINNOR has passed, promises of perfect memory, or a proposed replacement architecture.

| Capability | Evidence needed in the audited flow |
| --- | --- |
| Source preservation | Identify the original messages and tool evidence from which each critical retained item came. A summary alone cannot demonstrate that omitted details remain recoverable. |
| Current task state | Preserve the active objective, accepted constraints, unresolved questions, next required work, and relevant artifact identifiers without silently changing their meaning. |
| Corrections and scope | A correction supersedes the earlier value where intended; a hypothetical, quotation, assistant suggestion, or unrelated task does not become an accepted user instruction. |
| Temporal interpretation | Distinguish when a statement was made from when its subject event happened; resolve relative dates using the recorded conversation date and timezone. |
| Evidence retrieval | Verify that necessary source material enters the actual model request, including paraphrased and multi-source questions. Record a retrieval miss separately from a reading error. |
| Faithfulness and uncertainty | Retained statements have source support; unknown or unverified facts remain unknown or unverified. Measure important omissions separately from invented claims. |
| Action and artifact status | A proposed step, requested action, attempted execution, and observed successful result remain distinguishable. Verify actual artifacts separately from the assistant's status description. |
| Compaction continuity | The same critical items remain usable before and after compaction and after repeated compactions. Include a correction introduced between checkpoints. |

## Finite verification and reporting

For the requested 20–30+ message scope, a useful audit record must state the counting convention: user and assistant messages, complete conversational turns, tool items, and model tokens should not be conflated. Record the actual input budget, model identifier, relevant configuration, and whether compaction occurred. Thirty short messages without a compaction event cannot qualify compaction behavior.

The finite end-to-end trace set should cover: a critical early constraint; an equivalent middle-position constraint; a later correction; a paused task resumed after a topic switch; an exact artifact ID; a paraphrased reference; temporal ordering; multi-message synthesis; an unanswerable or false-premise question; and preservation of attempted versus verified action status. These cases exercise the criteria above. Repeat the relevant cases after an actual compaction boundary and after the configured repeated-compaction path. The trace set and repetition count must be fixed and reported before execution; passing a finite set supports only that bounded qualification.

Keep source messages, expected required facts and final behavior, model-visible inputs, summary versions, retrieved evidence identifiers, responses, and resulting artifacts in the verification record. For each failure, identify the earliest observed stage: missing source, compaction omission/distortion, retrieval miss, incorrect reading/update resolution, or downstream action/artifact failure. This makes a failed result reconstructible instead of attributing every error to “memory.”

Report required-fact retention, unsupported/contradictory claims, update correctness, unknown-answer behavior, evidence coverage, final task/artifact correctness, and token/latency cost separately. Report sample sizes and failures, including severe individual failures hidden by an average. Automatic semantic graders can assist review; their judgments need source inspection and deterministic checks where exact identifiers or statuses permit them.

## Remaining unknowns

This research does not determine FINNOR's actual prompt assembly, data durability, compaction boundary, retrieval scope, model-specific operating limit, or observed retention rate. It also does not establish a universally optimal summary length, retrieval count, schema, or compaction cadence. Those claims require evidence from the current implementation and the recorded end-to-end traces. A passing result should be stated as retention on the tested cases and configuration, rather than “the assistant never forgets.”
