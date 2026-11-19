# Z0 native run results (verify host evidence, not committed here)

Evidence directories: `/home/factory-user/repos/fzv-int-out/native/<run>/scenario-01/` on the verify host
(`z0-*-summary.json` per run). Commands start from the remote worktree at the head named below.

| Run | Head | Mode | Exit | Tally | Summary sha256 |
|---|---|---|---|---|---|
| w0-native-08 | c7c41ec | default | 1 | P0-01 FAIL (plpgsql `body` ambiguity, migration edit lost on sync) | n/a |
| w0-native-09 | f0c2533 | default | 1 | 11 PASS / 2 FAIL (P0-10 oracle premise, P0-11) / 7 NOT_RUN | not recorded |
| w0-native-10 | 5f49ede | default | 0 | 12 PASS / 8 NOT_RUN | 9a3834aebfb1d1b373e05be1e33a6a23626b0bd43fbf004fa31f85acc24655a1 |
| w0-native-11 | 5f49ede | kill | 0 | 12 PASS / 7 NOT_RUN | 4bb36b32b243bf99f99454d8cb5792512450b7c794ed762de47e952d5ca4d601 |
| w0-native-12 | 5f49ede | revoke | 0 | 10 PASS / 9 NOT_RUN | df7aced15e5531ce18c24c5288ed848d60cd2d3d69b324459d769acaaae971c5 |

Rerun (from the remote worktree, queue through `rbg.sh ... stack`):

    native-run.sh NAME z0 finnor-os/scripts/project-z/native/z0-session.mjs --no-worker
    /usr/bin/env FINNOR_Z0_MODE=kill   native-run.sh NAME z0 finnor-os/scripts/project-z/native/z0-session.mjs --no-worker --forward-env=FINNOR_Z0_MODE
    /usr/bin/env FINNOR_Z0_MODE=revoke native-run.sh NAME z0 finnor-os/scripts/project-z/native/z0-session.mjs --no-worker --forward-env=FINNOR_Z0_MODE

Observed values (w0-native-10): acquisition session MODEL_READY with S4 acceptance, model 4 operations, check
`ACCEPTED_EVIDENCED_DOMAIN`, 160 of 520 request units charged on the single original reservation, 16 exploration
domain actions (all linked to session requests), 0 unlinked domain actions, 0 pe_requests, portal writes 6 all from
session requests.
(w0-native-11): worker pid 156530 killed by SIGKILL at a POSSIBLE_EGRESS request, job quarantined
`reconciliation_required`/`lease_expired` with attempts and claim fence unchanged, resume reconciled the request as
VERIFIED by independent exact request and record transition, portal sends of the wire request 1 before and after,
session MODEL_READY, 251 of 520 units on the original reservation.
(w0-native-12): 16 application accounts disabled after 2 session requests; session FAILED with database diagnostic
`auth_profile_inactive`; 0 requests, portal logins or charges after the revocation; original programme PARTIAL
generation 1, original Work `executing` and the other Works unchanged.

Not run and why:
- P0-11 consumption: the default parent has one unresolved duty and no executable action; after S4 acceptance the
  continuation job is quarantined with `X1_SUPPORTED_ACTION_POPULATION_REQUIRED` (`institution-continuation.ts:71`).
  `consumeInstitutionApplicationModels` runs only for an executable duty that has no domain action yet, selected by the
  origin selector, which requires the unfinished duty to be held undispatched while the programme is WAITING/PARTIAL.
  The stock path dispatches executable duties immediately, so no quiescent parent of that shape was built. Unverified
  idea: policy requiresConfirmation for a first duty so a second duty on the same Deal stays blocked by `activeRoots`.
- P2-01..P2-04 mounted browser cases and P3-01 are not implemented.
