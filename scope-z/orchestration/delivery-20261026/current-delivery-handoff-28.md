# Current delivery handoff 28 (interim, written while workers F, G, H, I run)

Status: Project Z is NOT complete. Independently accepted phases: 0 of 6.
Z5 remains a terminal security stop (not lifted by the user in explicit terms).
Nothing staged, committed, pushed, published or deployed in the user's repositories.

Coordinator checkout: /home/factory-user/repos/finnor-z-coordinator (branch
factory/project-z-contracts, HEAD 9f3edfd3b4c6758832c53139da0773218062191e,
tree 2dc4d5bc13d22853cf4dc9feb5f6ac7fbf6bb9c9). Remote mirror at the same path on
finnor-z-verify (`ssh -F /tmp/fzv-ssh-config fzv`). D = scope-z/orchestration/delivery-20261026.

## Per-phase gates (only verified facts)

| Phase | Gate | Evidence |
|---|---|---|
| Z0 | Identity PASSED. 503 fixed (migration head). Parent reachability FAILED: run_objective_iteration job never claimed. Worker H diagnosing (h-native-02 running). | D/stack-fix-27/, D/claim-fix-29/ |
| Z1 | run-ci 256/256 PASSED (27). Native NOT_RUN: reconstruct-native.py:133-135 requires committed OWN source. User approved a scratch-copy commit; worker G building. | D/z1-z2-native-28/, D/z1-z2-native-29/ |
| Z2 | run-ci 256/256 PASSED (27). Native NOT_RUN: needs whole-owner-install.v1 receipt and 2–4 owner users (approved); worker G after Z1. | same |
| Z3 | Integrated: cut 01, continuation (W1), S4 executable pre-check (W2), owner result domains (E, 7/7), cursor v3 frame + bridge v3 + multi-channel consumer + coverage wiring (D, 7/7). Negative native refusal PASSED (Z3_ORIGINAL_NATIVE_MANDATE_REQUIRED). Positive native NOT_RUN (no parent request; depends on Z0). Worker I wiring domains + combined check. S5 renewable receipt NOT buildable: no original S5 renewable meaning exists. | D/z3-internal-28/, D/z3-owner-28/, D/z3-combined-29/ |
| Z4 | Native NOT_RUN. Grant NOT issued (coordinator-decision-01.json). Blocker: replay-authority.mts:84,136 requires https Auth. User chose real https; worker F implementing. | D/z4-native-28/, D/z4-native-29/ |
| Z5 | Terminal security stop. Not touched. | — |

## Verified integrated files (sha256 identical on both hosts)
- finnor-os/packages/db/migration-head.ts 7a0afddc9f2bbf3067554bfc4b677ae52a2fcfa65bd4ebebf53487ae30b52404
- scripts/project-z/start-isolated-app.mjs c882dbef73a4f45b12808818ed8ffcba15684891a920198cd061575bd6d1d4da
- z3-viability/general-owners.ts 0a0b57703eee614283b1939f321fec890299b9efdc8b706a9dc83f94d68a0066
- z3-viability/general-model.ts c407054ddf0d14ca9611a5526b38d39e3f37ddd4399e8cc5e6d2cf290986b0c0
- z3-viability/general-transition.ts 1ead1c27db33313140031086c5fc9ad2fc68cb3b8d00e51e670d3ef01bc567e9
- z3-viability/general-consumer.ts 44dc5237481505cb7d3d3b29f7416c7313a2407d6ed1c61259da185ac1e371c9
- z3-viability/consumer.ts c43735dd8425c6b974e2ae9a4aa6ac99425a9fbceb9fd1aa1848258f5fe34d1c
- z3-viability/store.ts a518c08366a4e07f3c7aae32345a9abfdf5afc53abb350ea01ac81895fcbdb83
- orchestration/.../general-revision.ts 6d220ca387cf137df35859642801a7acae0b8b579cb631460e13eafa34b1a9c9
- finnor-os/scripts/project-z/z3/general-native-frame-e2e.mts c08ad0fd2d3b48ee53158f2523ea52267d21c8a99c5ece1d0d22a791ebb5e2a8
- Protected originals unchanged: checker.py b71c0bec…837e, reference.py fa267cb6…f84e, transition.ts b4047f30…9029

Z4 files replay-authority.mts and reconstruct.py are being edited by worker F; not yet verified.

## Running workers (results not yet received)
- F 8e6b2f26-ac76-44aa-9038-398465637973: Z4 https Auth front + declared certificate + scope prep (no grant).
- G b5fd33d9-7090-4c96-b09c-d2222f8acc1f: Z1/Z2 scratch commit, reconstruction, install, native runs.
- H 2dce9989-e8b5-4a70-82c3-dbd109ea7b63: unclaimed job diagnosis and fix, Z0 parent, Z3 positive.
- I 06ae53c5-c68d-4770-8294-cf17040dad78: wire domains, combined check.

## Pending coordinator work
- Population 28: builder D/population-28/build_population.py, additions D/population-28/additions.json,
  dry run 01 (3,468 members). Add D's general-native-frame-e2e.mts and F/H/I files before the final build.
- Z3 item 2 (retained selection + application-owner consumption, needs migration + head update) after H.
- Z4 grant only if F produces a valid scope.
- postz_z4_execution_proof.sql is marked "Coordinator proposal only"; it must stay the migration head while it is in the migrations folder.

## Capacity
Remote: 7 GB RAM (often ~1 GB free), 4 cores, ~24 GB disk; one stack at a time.
Local: ~6 GB RAM free, 4 cores, ~4 GB disk: use for memory-bound checks (tsc, replays), not builds.
params-macbook-air and zphasefinnor: off-limits by earlier user instruction; the latest answer did not explicitly lift it.
