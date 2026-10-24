# Z1 handoff packaging contract

This contract precedes the handoff replay helper. The product cut is frozen at
`ebf8e4006df9b9f9e1e9cdc1a52234e823c1bf17`, tree
`2738732bed8ad245bb68e1c2265b91aaa815ed4c`. Subsequent changes in this handoff
are evidence and packaging only. They do not complete native integration.

## Failure model and observable acceptance

1. A source archive, patch, inventory or retained failure may change in transit.
   Check SHA-256 and byte length for every indexed asset before execution.
   Stream-check every retained evidence member against its separate inventory;
   reject duplicate, absent, additional, non-file or mismatched members.
2. A source archive may differ from the final tested cut. Check its decompressed
   tar digest against the final reconstruction's declared Git archive digest.
   Check all 16 phase source assets against that reconstruction's inventory.
   Include the pinned backend and public family registration, not borrowed Git
   objects, dependency directories, private evaluator assets or local config.
3. An apparently fresh replay may load the original checkout's dependencies,
   credentials or npm configuration. Extract into a new owned temporary target
   with no `.git` or `node_modules`; use a private HOME, cache and empty npmrc
   files, an allowlisted environment, locked npm ci and disabled lifecycle
   scripts. Require installed packages to resolve inside that target.
4. Toolchain or native loader assets may differ. Record and compare the actual
   Node/Python binaries, npm version, and installed tsx/TypeScript/zod/esbuild
   hashes with the final reconstruction. This is identity, not attestation.
5. A helper may overwrite evidence, escape extraction, run unbounded work or
   leave temporary assets. Require a new absolute evidence directory, safe tar
   extraction, the shared heavy lock, Node heap at most 1,536 MiB and bounded
   subprocess timeouts. Remove only its own temporary target, including on
   failure, and retain the failure report and logs.
6. A green package check may be confused with native or qualified behavior.
   The helper runs only existing kernel type checking, isolated translation,
   public original-programme E2E, process edges and local file-fixture recovery.
   It must report native owner/mount/application/protected proof as NOT_RUN.

## Finite proof

First verify all packaged asset and retained-evidence hashes. Then run one
fresh replay from the delivered source tar, with no source checkout overlay.
Acceptance is the same 256/0 original-semantics cases, 31/0 process edges,
three local interruption/restart cases, narrow kernel types and seven-file
isolated translation. Keep all original failed runs in the evidence archive.
The archive verifier checks integrity, not the truth of old claims.

The source archive is approximately 35 MiB before compression. Raw evidence
will be inventoried before compression. The replay installs only the existing
locked backend dependencies. Installation gets 600 seconds, each runner 240
seconds and each type/translation check 120 seconds. This is a bounded public
development replay, not a new comparison, protected campaign, original business
episode, OS sandbox or complete financial/resource meter.

Run the permanent helper with Node 22 on PATH:

```sh
python3 /absolute/handoff/replay-handoff.py /absolute/new/evidence
```

On this shared host it must hold
`/home/factory-user/repos/finnor-z-shared-heavy.lock`. A separately isolated host
may pass its own absolute owned lock path with `--heavy-lock`. No launcher,
authentication bypass, migration, seed, native grant, provider or effect is
invoked by this proof.
