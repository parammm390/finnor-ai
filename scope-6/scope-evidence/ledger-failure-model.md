# S6 ExperienceLedger transport candidate: preregistered failure model

This work implements a reviewable protected-boundary candidate. It does not
issue production admission, reviewer approval, a production signer or a claim
that a second process under the same operating-system identity is protected.
The frozen ExperienceLedger ownership remains S6 transport/enforcement with
each original semantic owner retaining its prepared content and qualifications.

Supported local domain: canonical JSON envelopes from S1–S6; authenticated
per-owner/per-tenant/per-principal credentials; exact immutable reference bodies;
append-only private history; explicit protected causal parents; owner-scoped
rights; separate sealed-evaluator append/read capabilities. Signed append and
reference receipts authenticate bytes, identity, order and release, never truth,
economic value or effect settlement. Unsupported record schemas fail closed.
S7/S8 receive permissioned reads and can be added only in a reviewed schema
release; they cannot rewrite owner history or grant their own release authority.

The ordinary content directory is untrusted for integrity. The minimal journal
and head anchor contain commitments, identity/reference constraints, signatures
and ordering, not producer content or projections. The process/key/config/journal
and head anchor require a distinct protected OS identity or admitted equivalent,
nonexportable or separately confined signing keys, trusted authentication and
reviewed release credentials. The local harness supplies keys solely in a
disposable test authority domain. Whole rollback of both protected journal and
anchor needs an inherited nonrollbackable counter or external trusted witness;
the implementation must disclose rather than claim to solve that dependency.

Failures to challenge before implementation:

1. A hostile producer changes tenant, principal, owner, rights, envelope identity,
   content preimage, subject/reference contents or causal parents.
2. Reusing an event/reference identity with changed bytes silently overwrites it.
3. Parent receipt belongs to another tenant/episode, references unknown history,
   uses a forged signature, or claims a future sequence.
4. An append response is lost, duplicate deliveries race, or the service dies
   between content persistence, journal persistence, anchor and response.
5. Untrusted storage is altered, truncated or rolled back; the protected journal
   is truncated independently of its head anchor, or an append follows an outage.
6. A caller reads sealed evaluator data without separate read authority, or
   exploits oversized/deep JSON, excessive backlog or slow request bodies.
7. Missing/mismatched release source identity, expired release or absent signing
   material allows the candidate to boot with broad/unscoped credentials or missing state.
8. Authentication says "S5" but the runtime accepts arbitrary self-declared
   content/release authority. Unknown references or a receipt-shaped JSON must
   never establish admission. Prepared records remain unchanged.

Persistence protocol: fsync immutable content before appending and fsyncing its
minimal signed commitment; atomically persist and directory-fsync a protected
head anchor before returning the receipt. Recovery accepts only verified journal
commitments. An orphan content file has no receipt/admission. A torn final journal
write can be discarded only past the protected anchor; prior accepted bytes are
never discarded. An anchor ahead of journal, a forked chain, missing committed
content or mismatched signature causes unavailable health and blocks append/read.
An audit outage retains the journal and existing responsibilities.

Budgets: one writer process per protected state directory, atomic OS lock;
8 MiB request maximum, depth 64, 100,000 JSON nodes, 256 references/parents per
append, 100,000 journal entries and 30-second HTTP request deadline. Local E2E
budget 120 seconds per case; no cloud/provider calls or paid resources. Monetary
costs remain explicitly unmetered. Load evidence registers 40 concurrent retries,
128 distinct records and 20 MiB peak request payload bound, with a 30-second
completion budget under the measured local environment.

This ledger does not fence external providers, isolate an arbitrary worker,
verify business truth or establish exactly-once effects. Its own append transport
guarantees are tested separately from S6 egress and S5 settlement. Production
qualification requires the external release/protected substrate and actual
upstream owner identities. No upstream status or evidence is rewritten.

## Typed detail digest challenge, registered before enforcement repair

S3, S4 and S5 prepare their event `contentDigest` from the exact event detail.
Their `revisionRef` names a separately committed canonical subject. S1 and S2
have different typed digest contracts and must retain them. Inspection confirms
that the existing generic OR fallback already allows valid distinct detail and
revision digests; an earlier suspicion that it rejects them was incorrect.
The suspected defect is acceptance of an invalid S3–S5 detail digest merely
because it matches the revision commitment. Reproduce before claiming a bug.

Authoring gate: (1) exact typed owner detail must match its declared digest, while
a valid separately committed canonical subject remains accepted; (2) a fallback
to the subject digest can accept rehashed malformed owner records; (3) existing
S5 fixtures bind the revision directly to the same detail, so they cannot expose
this substitution; (4) extend the existing actual separate-process append runner,
without production seams, fake receipts or extra helper-only tests. A synthetic
typed S5 byte-contract challenge is not native S5 business/settlement integration.

First commit one known canonical subject whose digest differs from a prepared
S5 event detail, and require successful append. Then change the detail and declare
the subject's digest, recompute only the prepared event identity, and require
`EVENT_CONTENT_PREIMAGE_INVALID` with no new journal sequence. Both requests use
the actual authenticated append boundary. Keep baseline failures and every
existing case. No relevant edits during the scored run. Existing 120-second case,
8-MiB request and disposable authority limits apply; billing stays unmetered.

The frozen `ledger-typed-detail-baseline` run passes all 17 existing cases but
accepts the malformed typed detail (HTTP 200), advancing the independently read
sequence from 2 to 3. Sources remain unchanged. This is a demonstrated authenticated
record-integrity defect, not evidence of an external effect or business settlement.
Repair the actual append owner to require the exact detail digest for S3–S5, while
retaining S1/S2's different contracts and canonical revision resolution.

`ledger-typed-detail-repaired` passes all 18 cases with source freeze. The changed
detail is refused at the intended preimage check without advancing history, while
the valid distinct subject/detail case and all original protections remain green.

## Torn writer diagnostics after established kernel ownership

Register before new test or production repair. Kernel flock owns the writer; its
PID/diagnostic JSON must not become a second ownership authority or strand accepted
history after a crash. Recovery must keep the same lock inode, authenticated
journal/head/content and original receipt, with exactly one current daemon.
Malformed legacy/migration state must remain refused when the protocol cannot
be established. No PID-name lock replacement, unlink or history rewrite is allowed.

Authoring gate: (1) after an actual writer accepts one protected record and is
physically SIGKILLed/reaped, a real descriptor truncation of only its diagnostic
tail must allow one kernel-fenced successor with the same receipt; (2) treating
diagnostic JSON parse as ownership/liveness can refuse every successor, while an
unsafe reset/unlink can permit concurrent writers; (3) existing 32 contention
rounds restart complete diagnostics and contain no accepted record, so they do
not reach torn-metadata recovery; (4) extend that same separate-process writer
runner, using actual authenticated append/read, filesystem fault and OS process
death, without production callbacks or supplied receipts. The record is a
synthetic S5 byte-contract input, not native S5 economic consumption.

Before repair, preserve all 32 rounds and append one new independent case. Start
the actual daemon, independently verify its real sequence-1 signed receipt,
record lock inode and journal/head hashes, SIGKILL/reap, then truncate only the
diagnostic file tail on the same descriptor/inode. This is a registered torn-
metadata storage fault after death, not a claim of killing during a write syscall.
Start four actual contenders; require one READY/healthy writer, unchanged
accepted commitment, identical independent readback and idempotent append receipt.
Save process/fault/hash evidence before assertions so baseline refusal is retained.

Candidate repair: durably install an unambiguous kernel-protocol header before
updating diagnostic bytes; later diagnostic writes preserve that header on the
same never-unlinked descriptor. Once kernel ownership is acquired, the diagnostic
tail cannot influence ownership. Compatible complete prior v2 JSON may migrate;
live v1 PID state remains refused. A torn first installation/unknown legacy format
still requires explicit operator migration and cannot be silently reclassified.
Protected file/OS/release identity and filesystem flock semantics remain inherited;
this does not solve rollback witnesses, arbitrary NFS/OS deployment or safe-read
descriptor races. The full frozen gate remains required.

Bounds: existing 32-round stress retains its 300-second budget; the separate new
fault case has 120 seconds, at most four concurrent daemons, 15-second boot and
10-second HTTP bounds. Retain source freeze and supervisor-only rusage; aggregate
daemon quotas and monetary costs remain unknown. All test keys/releases are
DISPOSABLE_TEST_AUTHORITY, never production approval.
