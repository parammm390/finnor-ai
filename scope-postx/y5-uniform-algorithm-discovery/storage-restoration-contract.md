# Byte-preserving task-owned storage restoration

Heavy verification is stopped below the existing 1.6 GB floor. The Markov
dependency attempt and a backend TypeScript heap failure are retained. Their
combined full-host memory and disk effects were not measured, so the cause of
the additional global disk loss is not established.

Before changing any asset, record available space and both declared runtime
inventories. Only the integration checkout's own marked Lean asset directory
may be rewritten. The original Y5 checkout is a read-only donor.

Hypothesis: replacing a task-owned duplicate with an APFS clone of identical
pinned donor bytes can recover space without changing any runtime bytes.
First try one largest file. Stop if there is no measurable global gain.

For each replacement, require canonical, regular source and target files,
matching declared runtime identities, the exact source and target SHA-256 pin,
unchanged inode/size/timestamps during verification, and an independently
hashed new APFS clone. Only then atomically replace the owned target.
Preserve its mode and verify the final bytes. Never fall back to a full copy,
follow a link, remove an asset, alter the donor, delete failed evidence, clean
peer work, or change the original verification floor.

Record before/after available space, every replacement, byte hashes and
failures. A global space delta is not a proof of physical extent sharing.
This maintenance is neither native execution nor a Y5 qualification pass.
