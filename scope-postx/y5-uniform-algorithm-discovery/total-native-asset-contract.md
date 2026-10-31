# Frozen interpreter asset, before implementation

The generic `Total.lean` module is fixed runtime infrastructure, not a discovered
family proof. Current native evidence spends roughly 14 seconds rebuilding that
unchanged module on every independent check. A use must still finish inside the
original HTTP deadline, including authentication and original-owner checks.

## Concrete implementation boundary

- A developer setup command compiles the actual frozen source with the pinned
  toolchain and separately replays its kernel object. It writes a deterministic
  source/object/runtime pin and an explicitly unqualified setup-cost receipt.
- The pin is part of the owner source closure. Runtime loading checks the current
  source bytes, toolchain identity and exact object bytes against that pin.
- Every independent check copies and kernel-replays that exact object in its own
  scratch directory. It still reconstructs the candidate from the closed AST,
  compares the rebuilt candidate object, replays the supplied object, and checks
  the independently expected type, actual imports and used axioms.
- The additive-prefix correspondence theorem is included in the axiom inventory.
  It is a generic semantics bridge, not a supplied successful algorithm.
- There is no missing-asset recompilation fallback and no extended deadline.
  The setup receipt is not an independent bill or a free resource grant. Complete
  money, human time and aggregate memory remain unknown.
- This does not qualify an OS sandbox, aggregate memory cap, protected custody,
  independent trust-policy approval, S8 admission or business improvement.

## Falsifiers and finite check

The prewritten asset driver uses a fresh owned asset directory. The real setup
command must build/replay the source. Runtime loading must perform a replay, not
another compilation. Changed source, missing/wrong object bytes, a symlinked
asset directory, wrong toolchain identity and missing setup provenance must
refuse before any native child starts. Tampered copies are retained separately.
The existing native discovery driver then rechecks the full synthesis, original
prefix target, supplied object, same-definition execution and hostile capsules.

Commands use exclusive evidence directories and the unchanged 30-second native
call bound. At most two undiagnosed trials are allowed. A diagnosed correction
gets a new evidence directory; earlier failures remain.
