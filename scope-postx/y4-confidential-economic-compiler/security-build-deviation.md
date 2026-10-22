# Secure OT build deviation, before any accepted MPC result

The first encrypted three-party engineering episode, `numerical-001`, compiled
the candidate and passed its independent correspondence check. All native
participants then aborted during setup. MP-SPDZ v0.4.4 refuses its KOS15 path
without `-DINSECURE`, citing ePrint 2022/192. That flag is **not permitted**.
No input-dependent output was accepted.

The initial design's KOS15 suitability statement was incorrect. Retain the build
and failed episode, but do not use them as cryptographic or runtime evidence.
Profile 1.1.0 replaces that dependency with MP-SPDZ's supported malicious
SoftSpoken path, using its pinned libOTe 1 / cryptoTools submodules:

- libOTe `558f74d5b6bd557b62bfb06699f014c0931da466`;
- cryptoTools `99ad8c3112efb4bbeaebe574a0acc1d41c19ef7a`.

No threat, exact-arithmetic, commitment, query or qualification threshold changes.
The conditional KOS-only compile guard patch becomes irrelevant on this path.
No runtime `use_kos`, insecure compiler flag, fake preprocessing, disabled MAC
check, plaintext transport or semi-honest fallback is allowed.

Build one compiler at a time. libOTe's build flags use `-O1 -g0` to bound disk
and memory. Its protocol source is unchanged. The local MP-SPDZ listener is
restricted to IPv4 loopback. This build cannot qualify separately administered
participants or production deployment.

Every dependent acceptance check must be repeated after the new executable,
shared library, linked static libraries, sources and profile are identified.
The earlier compiler/checker engineering report remains historical, not evidence
for the revised profile.
