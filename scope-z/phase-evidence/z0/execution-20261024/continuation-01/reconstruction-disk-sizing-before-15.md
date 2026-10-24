# Fresh reconstruction 20 storage sizing, before launch

Earlier reconstructions used an 8 GiB available-space guard. Preserve those
receipts and do not claim that predicate passed if it did not. The latest
read-only observation is 6,638,604,288 available bytes. Do not delete old
outputs, dependencies, caches, failed targets or any user work to make room.

The independently retained complete reconstruction 15 contains 99,000
regular files totaling 2,088,512,272 bytes. Its largest recorded temporary
download cache is 394,313,423 bytes; the standard reconstruction removes only
its own newly created cache after native compilation. This size evidence is
historical engineering data, not proof of current-source correctness.

Before the next launch, require both root/backend package manifests and
dependency locks in the newly frozen source to match that measured target.
Reject the sizing model if any of these four pins changed.

Conservatively sum the entire retained installed target, that temporary
cache (even though it is removed before final emission), a 1 GiB filesystem/
source-growth allowance and 128 MiB of extra graph/manifests:

    2,088,512,272 + 394,313,423 + 1,073,741,824 + 134,217,728
    = 3,690,785,247 bytes projected additional peak.

For this new engineering-only run, require 6 GiB available under the shared
heavy lock, leaving 2,751,665,697 bytes beyond that conservative estimate.
Also require at least 2 GiB of predicted remaining space. This is an explicit
change to the local host-storage planning threshold, not a claim to have
satisfied the earlier 8 GiB predicate. Do not lower the new threshold again
if it fails. Retain an actual refusal before launching if space is insufficient.

Use a new source capsule and new output target with the unchanged full
reconstruction CLI, all fresh target-local dependency/native/browser installs,
full backend type graph, actual frontend build, mounted seal, complete
emission and offline installed doctor. Keep the 4096 MiB heavy-check cap.
No in-place rebuild, dependency borrowing, partial graph or source fallback.

No native S5/S6/S7 budget, deadline, financial authority, DB/Auth permission,
shared-file ownership or protected qualification changes. No historical
target or cache cleanup is authorized by this sizing calculation.
