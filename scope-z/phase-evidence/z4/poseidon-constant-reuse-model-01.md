# Immutable Poseidon-constant reuse, before the native source change

One bounded original T=64 observation now records the actual boundary:
proving succeeded (exit 0, 110484196 CPU microseconds), but `commit`
was killed with native exit -9 after 10001609 CPU microseconds, with
timedOut=false and about 11 MB peak RSS. Its fixed CPU ceiling was 10 seconds.
This identifies the measured failing operation, not the historical cause of
every earlier failure.

Read the exact pinned Nova provider and traits at
01b1e2d662a847ed7029770ecbaf6687398899dd. Its
PoseidonConstantsCircuit::default regenerates both wide and narrow
constants. Our native hash and circuit constructors request that default
for every invocation. Reuse immutable constants once per process while
creating fresh oracle/sponge state for every hash.

The hypothesis is repeated constant generation, not insufficient memory.
Do not increase CPU, memory, wall, profile or original-business budgets.
Do not change sponge width, strength, domains, absorption order, bit
truncation, relation/compiler version or setup/security assumptions.
Do not cache mutable oracle state or results.

Required actual-artifact evidence:

* Rebuild both native executables with the same pinned Rust/Cargo lock.
* Verify retained genuine proofs and their exact plan/parameter hashes.
  Match original input commitments against existing successful coordinates.
* Repeat affected T=64 and T=256 diagnostics under the unchanged ceilings.
  Preserve all original failures and report new observations separately.
* Re-run the existing native critical falsifiers and no-interpreter-replay
  proof E2E, then separately rebuild/install native assets again.
* No timing ratio or full-cost value claim is permitted from the hypothesis.
  Actual eligible demand is still zero and qualified security remains UNKNOWN.
