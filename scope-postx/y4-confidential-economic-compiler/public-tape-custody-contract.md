# Authorized public compiler tape archival

The user explicitly approved verified lossless archival of completed
Y4-generated public compiler tapes to recover working space. This is not
permission to delete inputs, participant ledgers, installations, private state,
failure reports, native libraries or unrelated files.

Before implementation, register failures: a live compiler/native process, wrong
directory or owner, links or unexpected names, archive capacity exhaustion,
partial writes, changed source bytes or metadata, duplicate/missing/extra archive
members, mismatched hashes/modes, and interruption during raw-copy removal.

Restrict the operation to regular `.bc` files in an explicitly selected
`/dev/shm/finnor-y4-programs-NNN/Bytecode` or
`/home/factory-user/y4-tools/native-programs-NNN/Bytecode` working directory.
These are generated tapes, not installed library/source members. Refuse live Y4 compiler,
participant or native processes. Create a new archive and independently read
every archived member, verifying its exact bytes, size and mode against the
unchanged source. Write a complete verified inventory before unlinking anything.
Recheck the exact frozen regular source file immediately before each individual
unlink. Never recurse for removal or remove directories.

Retain a failure receipt and archive on any error. An interruption can leave
some raw copies present, but every removed byte must already be independently
verified in the retained archive. Record original and archive storage, including
any temporary-filesystem durability limitation. Do not resume old computations,
refund costs or change disclosure reservations.
