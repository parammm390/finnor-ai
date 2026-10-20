# Bounded S6 read allocation, pre-code contract

## Recorded failure and diagnostic

Native campaign 8 on clean ee1a186 fails after 139.158 seconds, with
2,457,038,848 sampled peak aggregate RSS bytes. During the second-use pause,
all 26 refusals and two controls finish their expected dispositions and
complete before/after comparisons. The remaining validation crosses the
original 7,000-ms suite deadline. The campaign remains FAIL, including its
consequential business-composition failures. Campaigns 6/7 qualify only their
recorded earlier development cuts. PR #143 now discloses this regression.

The private live transcript records 57 complete READ requests taking 4,075 ms
in total, before caller-side validation and persistence. READ is not an
optional comparison. Each request still checks every S6 committed content
file. The retained S6 store has 169 content files totaling 698,839 bytes;
168 files are smaller than 64 KiB. The current bounded reader allocates a
fresh 64-KiB chunk for each small file, then another for its EOF check.
That allocation pattern is a hypothesis to measure, not an established
cause or a promised native pass.

## Bounded proposed change

First write and run an artifact-producing isolated diagnostic against the
actual extracted, source-hashed `safeRead` implementation. It must use real
file descriptors, record counts/allocated bytes/timing on the retained
content without printing content, and preserve those inputs byte-for-byte.
Record its failure model before implementation: empty and small files,
64-KiB boundaries, multichunk files, 8-MiB content and 256-MiB journal
limits, already oversized and concurrently growing files, truncation,
same-descriptor path replacement, symlinks, nonregular files, and secret
permissions. Inject only I/O observation or a deterministic mutation of an
owned disposable file after the real descriptor stat. Never modify the
retained native inputs.

Before runtime edits, extend the existing real separate-process S6 HTTP
artifact E2E with many small committed files and multichunk content, fresh
signed snapshot reads and corruption of an unrelated committed file.
Keep its existing synthetic 128-entry policy, witness, rights, signatures,
tamper cases, limits and no-authority scope. Run the extension on the
original implementation and retain its result.

Only if the diagnostic establishes the excess allocation, size each read
chunk from the descriptor's initial remaining size plus one byte, still
capped at 64 KiB and the unchanged remaining byte allowance. After observed
growth passes the initial size, return to normal bounded 64-KiB chunks.
Read to genuine EOF and hash all the same bytes. Do not use `readFile`,
cache data or authorization, trust stat as EOF, skip an EOF read, increase
concurrency, retain open descriptors, omit integrity checks, change fault
ordering, or change any grant/deadline/queue/wire/byte bound.

## Validation and limits

Run the same diagnostic and entire extended real HTTP E2E after the narrow
reader edit. Record source hashes, original/ending native-content digests,
actual boundary results, allocation counts, timings, owned cleanup and
repeat commands. Check affected strict types and review the complete delta.
Then run one preregistered fresh native campaign with unchanged original
7-second suite, 8-second pause, physical fence, currentness, resources and
all ending-state/source comparisons. A faster component is not a native
pass; a native pass is not installed or whole-phase qualification.

Do not publish another source push while the current installed CI is
running. No production, protected admission, deployment or Mission action.

## Pre-edit observations

The actual extracted helper passes all 20 prewritten boundary groups,
including exact 8-MiB content / 256-MiB journal reads, oversize and growth
refusals, real descriptor replacement, symlink/FIFO/directory refusal and
secret permissions. Eighty complete reads of the retained 169-file store
allocate 1,782,579,200 observed chunk bytes across 27,200 allocations/read
calls. Median per-pass time is 18.784 ms; total is 1,543.200 ms. All retained
input digests are unchanged. The observer reports 2.800 seconds and
623,726,592 sampled peak RSS bytes. This confirms excess allocation, not
that allocation caused the native deadline failure.

The extended real HTTP E2E passes all 39 groups on the original reader:
123 committed files, 40 fresh witness-backed pressure reads, all original
signed-response/storage/witness negatives and unrelated pressure-file
corruption. Pressure reads total 1,120.895 ms. Observer: 5.530 seconds,
349,827,072 sampled peak RSS bytes, owned processes stopped. Neither result
is native, installed or qualification proof. Private receipts retain exact
source hashes, raw timings and rerun commands.

## Post-edit component and HTTP results

The identical 20-group diagnostic passes. The same eighty full retained-store
passes allocate 55,934,160 chunk bytes, a 96.862% reduction, with unchanged
27,200 read calls and descriptor closure. Median time is 17.412 ms, total
1,404.409 ms. All input digests remain unchanged. Observer: 2.720 seconds,
624,164,864 sampled peak RSS bytes. The large boundary fixture dominates
that RSS measurement; this is not a memory-qualification claim.

The complete extended HTTP E2E passes all 39 groups with 123 committed files
and forty fresh witnessed pressure reads totaling 942.743 ms. Its unchanged
storage, response, witness and unrelated-file tamper cases all pass, with
unchanged journal/head across every read challenge. Observer: 5.017 seconds,
346,357,760 sampled peak RSS bytes, all owned processes stopped.

The affected full S6 strict type project passes with noEmit and
allowImportingTsExtensions: 28.943 seconds, 2,434,584,576 sampled peak RSS
bytes. The complete small delta receives local two-pass review, including
actual EOF/growth arithmetic, descriptor cleanup, 128-entry fixture capacity
and all original refusal cases. No actionable candidate is verified; this
is not a new independent whole-phase review.

Next validation is one separately preregistered campaign 9 on the clean
committed repair, with original native flags and limits. Its result is
pending, not inferred from these passing narrower checks.
