# Versioned M3 adapter contract, pending authentic producer

`challenge-submit` accepts a Work ID and strict `CapitalProgramRef`, not module
JSON or an owner-artifact union. It must resolve the actual authenticated M3
reader, validate original module/compiler/IR and ownerBoundGraph/evidenceSlice,
then bind current S1–S6 claims, rights, clocks and original evaluation.

The reader must return immutable preimages plus its exact producer identity and
currentness/recheck operation. Claims cannot come from a caller-provided score.
Repair must invoke the actual M3 new-version producer, retain earlier applicable
witnesses and recheck their affected closure. No M4 owner-policy mutation.

Observed committed M3 cut f4b74450f7fd21a7b7080db2b2a9c72488c5fe46 exposes
native construction only. Its `INDEPENDENT_NATIVE_CORE`/PROPOSED/BLOCKED output
contains null mandatory owner refs. Consequently no adapter is registered as an
authentic reader. The product submit path returns a pending ref-resolution error
and no issued ChallengeResult. Native diagnostics cannot satisfy this port.

Future join requires exact committed phase/shared patches, schema/parser export,
owner reader, module+graph preimages, M1/P4 final-source rederivation, claim and
evaluation binding, currentness and new-version repair receipt. Do not join dirty
peer files or guess a future signature. The future M2 scheduling request is
candidate/claims/targets/domain/checkers/remaining-parent-resources/deadline;
the bounded native scheduler is not a DeliberationPolicy producer.
