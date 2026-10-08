# Prospective evidence packaging contract

Registered before writing the continuation packaging utility. This is a local
delivery/reconstruction check, not a new economic test, independent seal, or
qualification of a later code version.

The raw M3 evidence now exceeds 1 GiB. Preserve it locally and commit lossless
per-run archives rather than thousands of repeated uncompressed owner records.
Include every discovered completed M3 run, including failed, setup, unmatched
and browser-blocked runs. Do not include another phase's evidence or live
credentials. Do not archive an active run until it finishes.

Failure modes and required checks:

1. **Omitted or rewritten failures.** Enumerate every completed raw M3 run
   directory. Record the observed case/result status and exact receipt hash.
   No empty, unmatched, partial or failed run becomes PASS.
2. **Unsafe file types or paths.** Refuse symbolic links, FIFOs, devices,
   absolute archive member names, traversal and duplicate members. Archive only
   regular files and do not execute or extract evidence during verification.
3. **Changed bytes during packaging.** Hash each original before reading it,
   check the bytes actually archived, and verify every archive member against
   the original manifest after writing. A changed source fails delivery.
4. **Lost identity or permissions.** Preserve each original relative path,
   length, SHA-256 and file mode. Record archive digest/length separately.
   Generated archives and manifests use private local permissions.
5. **Overwritten evidence or half-qualified output.** Create archives and
   manifests exclusively. Existing outputs refuse. A failed archive remains
   failed and is never reused under its old name.
6. **Misleading source qualification.** Index each receipt's actual source cut
   and selection. Earlier original-owner/build/install passes remain earlier
   exact-source results unless a new affected rerun qualifies the final source.
7. **Unusable handoff.** Provide the exact feature base, phase/shared patches,
   shared old/new file hashes, source manifest and reconstruction instructions.
   Exclude the preexisting dirty P4 runner, all peer evidence, generated Next
   files and the unchanged untracked historical base receipt from staging.

Validation must independently reopen every archive and check all members
against retained original hashes. Git status and staged diffs must confirm the
owned path set before commits. No push, PR, deployment, peer cleanup or
historical acceptance change is authorized by packaging.
