# Task-local finite episode retention

Large participant compiler workspaces may execute in a new task-specific tmpfs
directory. After every producer has stopped, `retain-episode.py` may copy the
finished episode to a new, private task-delivery directory.

The same retention rules cover a stopped `adverse-NNN` native-fault episode.
Its final `result.json` must identify a non-protected adverse case with only
terminal fault observations. A failed adverse episode stays failed; retention
cannot promote its outcome. The source and destination case/number must match.

Failure predicates, fixed before this helper's implementation:

- Never replace, move, remove, chmod or resume the source episode.
- Reject existing destinations, non-task paths and special files.
- Do not follow links. Only an owned session's `Programs` link into the same
  original episode may be retained, with its literal target unchanged.
- OpenSSL's `Player-Data/<8 hex digits>.<index>` links may name only a regular
  `P<participant>.pem` in that exact directory. Keep these public-certificate
  aliases literally; do not follow them or admit any private-key alias.
- Compare every retained regular file's bytes and every link target. Verify
  that the source did not change during copying.
- Keep participant state and all private logs inside the private delivery
  tree. Never publish their contents or per-file hashes in the custody receipt.
- Preserve partial output on failure; do not clean or silently retry it.
- Retention is not another computation, a ledger reset, preprocessing recovery,
  an independent installation, or protected qualification.

Native public program archives are created separately from their verified
public manifests. The handoff sealer reads only explicitly allowlisted public
receipts and producer source files, not this retained private tree.
