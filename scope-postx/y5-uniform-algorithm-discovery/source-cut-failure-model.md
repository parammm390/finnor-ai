# Source-cut bounded-I/O failure model, before implementation

Scope: actual `currentUniformEnvironment()` with the complete real source-path
inventory, copied exclusively into a new verification directory. No owner,
mathematical, native, manifest-membership or qualification changes.

Failures and prewritten oracles:

1. Unbounded Promise.all opens exceed an ordinary 128-FD child limit. Preserve
   the original child's EMFILE, counters, stdout/stderr and exit status.
2. Overlapping cuts multiply opens. Bound active source reads to 16; synchronous
   overlapping callers may share one not-yet-started complete scan.
3. A caller arriving after a scan started could join after a changed file was
   already hashed. Such callers must await a subsequent complete scan, not that
   older scan. Pause an actual fixture read, change an already-read fixture
   file, call the actual boundary again, and require the later caller to reject.
4. Success caching or metadata shortcuts hide later changes. Each sequential
   cut must read every listed file. Same-size changes with restored mtime must
   reject. No path, digest, byte content, or transitive dependency is omitted.
5. Missing files must reject, and restoration must permit a fresh scan. Rejected
   current scans must not leave an in-flight slot stuck or turn into success.
6. Updating an emitted expectation does not update the loaded image. Mutate
   only the fixture's in-memory emitted expectation and its matching source;
   the actual boundary must require restart rather than accept a new identity.
7. Shared results must not expose mutable identity. Require frozen environment,
   files array and file records; attempted mutation must not alter later cuts.
8. Parallel read failure must not abandon still-running reads and start another
   batch over them. Drain the bounded readers before releasing the scan slot.

Preregistered driver: `finnor-os/scripts/postx/y5/verify-source-cut.mts`.
Run before implementation with `--phase baseline`, then after implementation
with `--phase bounded`, always a new absolute `--output` directory. The driver
copies all real listed files, records their hashes and code/driver identities,
and prepares only the fixture's emitted manifest to match its bytes. This
preparation is not a verification pass or independent source acceptance.

Artifacts: preparation inputs, child command/FD limit, observed per-file read
counts, maximum concurrent reads, mutation/restoration steps, child evidence,
stdout/stderr, summary and rerun command. No native/build/server/browser work.
No OS atomic snapshot, arbitrary computed-asset discovery, protected custody,
semantic acceptance, or mathematical qualification is established by this test.
