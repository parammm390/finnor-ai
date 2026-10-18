# Failure model, written before the reference model

This is an independent development design, not an observed defect report.
Each failure below needs strongest-boundary evidence, not a unit helper assertion.

| Failure | Decisive observation / owner boundary |
|---|---|
| Float rounds 9007199254740993 to 9007199254740992 | Persist/read exact strings and refuse one-minor-unit mismatch at canonical record command |
| Different currencies match equal numbers | Reject USD/INR match; no FX normalization |
| Invalid quantity or 39-digit sum accepted | Refuse before reconciliation; unchanged durable state |
| Missing/conflicting/stale source treated as zero/current | UNKNOWN/CONFLICTING/STALE observation; no approval advancement |
| Role string grants authority; another tenant/scope can read/mutate | Authenticated owner denies; no foreign data or writes |
| Analyst grants self partner role; same person fills both approvals | Principal separation denies at durable approval boundary |
| Revoked partner approval reused | Current authority recheck denies preparation; approval history not erased |
| View-time authorization races durable write | Owner atomic preconditions reject changed revision/currentness/authority |
| Release edit retroactively lowers old threshold | r1 immutable and retained; r2 only for new/revised records by explicit edit |
| Source refresh rewrites original evidence | Original refs persist; old record reads STALE; preparation refused |
| Edit carries forward approvals or proposal | New revision DRAFT; original immutable snapshot retained |
| Retry/restart duplicates proposal or executes | Canonical proposal count exactly one; execution count zero |
| Injected source/effect receipt masquerades as owner result | Owner-derived readbacks only; fixture supplies no success receipt |
| "Generic" compiler is a fixed demo or executes source | Independently authored second declaration changes fields/rules; typed invalid/unsafe nodes refused |
| UI-only mock bypasses actual queue/DB/identity | End-to-end caller -> owner -> durable readback with real worker lifecycle artifact |
| Fault hidden by success receipt, swallowed error or skipped case | Exact selected-case census, failure codes, rollback and nonzero verifier exit |

Crash/fault campaign must include failure before commit, after proposal commit
before reply, restart/redelivery, concurrent record edit, source refresh,
authority revocation, missing adapter, stale release and cross-tenant inspection.
No partial application mutation or dispatched effect is allowed on a denial.
The reference model is not evidence of transaction isolation, queue delivery,
canonical authorization, crash safety or resistance to hostile compiler inputs.

Protected 20/60, S8, production, 100x and financial gates are separate NOT_RUN
obligations. Their owner protocols, populations, denominators and custody are
UNKNOWN here. In particular, 20/60 is retained verbatim, not interpreted as a
passing score, sample count or timing budget. Do not weaken or invent thresholds.
