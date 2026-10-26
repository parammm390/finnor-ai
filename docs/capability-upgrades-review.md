# Capability additions: code review

Base: `f4c2e41c8a0222c9d83ca1be821b3aef888da08a`. This review covers the complete ten-capability change, its existing callers and the failed PR 156 check set. Standards and intent were reviewed in separate sequential passes by the implementing agent. This is self-review, not independent certification.

## Findings and corrections

| Finding | Correction and verification |
| --- | --- |
| P1: TypeScript/tsx resolution hid missing public tools subpaths from the Vite runner. The planner import consequently broke suites across all three test shards, Phase 7 and Scope 4. | Declare every consumed tools subpath as a package export and derive Vite owner aliases from that manifest. The focused boundary suite and all 96 unit suites pass locally. |
| P1: The image requested OpenSSL/libssl3 `3.0.22-1~deb12u1`, which the current Debian repository no longer serves. | Retain exact pins and update both to the available `3.0.22-1~deb12u2` security revision. Both amd64 and arm64 availability were checked against Debian's package metadata. The exact image build remains a CI qualification gate. |
| P1: Docker omitted the reviewed Docling model manifest, while provisioning silently skipped its comparison when absent. | Copy the reviewed manifest into the provisioning stage; require it and the expected package version before downloading. An isolated real invocation without the manifest refuses before creating a model directory. |
| P2: Disabled planner optimization eagerly imported its implementation and dependencies into unrelated callers. | Load reviewed activation only for explicitly enabled owner background planning, retaining replay exclusion and downstream authority checks. Existing planner/owner unit suites pass. |
| P2: The API configurator rejected valid same-project Secrets Manager ARNs while accepting named references. | Preserve named references and ARNs for the selected project and Region. Eight real configurator dry-run cases capture before/after behavior and reject other project/Region ARNs with network disabled. |
| P2: The Python engine registry advertised a nonexistent PageIndex program. | Remove that unused variant. PageIndex continues through its actual server-side HTTP client and immutable source binding. |
| Audit gap: Nango's signed callback was not classified by the API boundary inventory. | Record the exact signed callback boundary, with native cold-load, exact-byte HMAC and prepared-owner routing proof. No console-JWT exception is granted to ordinary capability routes. |
| Release drift: independent rollout fixtures and generated authorization/UI coverage inventories retained their old contracts. | Refresh the inventories and per-class fixture expectations. All 81 release regressions pass locally, preserving no-op rejection and production mutation authorization. |

## Standards and scope checks

Reviewed the HTTP/auth boundaries, app/worker role split, forced RLS, append-only migration lineage, frozen document versions, idempotency, uncertain provider outcomes, lease/deadline/authority publication fences, provider cleanup, bounded execution, private derived evidence, opt-in planner preference and non-root image packaging. The worker image layout check verifies relocated source custody. UI document controls remount on the exact document/version key; component checks exercise lost acceptance, source changes and candidate review receipts.

The additions use the existing API, HEAVY job queue, worker, evidence and Centropy owners. They do not grant business execution authority or establish generalized model gains. WorkOS and private-provider enrollment are not implemented by this change. No new local review subagents were used.

Production credentials were separately provisioned as managed references. IAM simulation checks all eight resource-specific decisions for each principal: API/HEAVY can read eight; INTERACTIVE/BACKGROUND can read only two telemetry references; REALTIME can read none. Simulation is not a proof of credentials used by a running task.

## Qualification still required

Do not infer production readiness from this report. The final PR revision must pass all applicable CI, including the full database-backed shards, Phase 7, Scope 4/5, the exact worker image and the required verdict. Merge/deployment must retain the canonical release process. Verify the authenticated deployed journey, live provider callback configuration and resulting fleet after rollout.

Sources for the package-pin correction: [Debian OpenSSL](https://packages.debian.org/bookworm/openssl), [Debian libssl3](https://packages.debian.org/bookworm/libssl3).
