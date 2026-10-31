# Complete release input generation

Registered before replacing the piecemeal generation process. Actual Linux run
41228022129 at `385ec31349cd1994dbf98e22d377d7f6e1d3ebd9` passes backend
contracts, backend types, root types, lint and workflow validation, but fails the
frontend inventory and release provenance gates. The generated API client and
capability catalogue are stale; the isolated supplier and intended release
contract retain an older migration head. Earlier run 41213242478 also reproduces
stale prebuild source stamps in the relocated worker.

One command must generate the complete existing chain in dependency order:
workspace compatibility, exact ordered migrations and all required head pins,
authority matrix, backend OpenAPI and action manifest, both frontend clients,
capability and human-form catalogues, actual API prebuild stamps, planner source
manifest, and frontend coverage. The intended-release head is source metadata,
not a statement that deployment occurred. No deployment or resource mutation
belongs in this command.

The paired check command must recompute each artifact through its real owner,
refuse every stale result, report each failure, and leave all source bytes
unchanged. It must preserve the existing full product-boundary and deployment
truth validators. Generating a stale artifact during a check must never turn a
failure into a pass. Exercise the actual CLI by introducing a reversible stale
generated client, retaining the nonzero check, restoring every original byte,
and rerunning the complete check. Verify generation is idempotent by comparing
the complete tracked source patch before and after a second generation.

The actual repeat-generation trial 002 fails this last requirement: both the
action manifest and frontend coverage generator replace their capture timestamp
despite unchanged computed content. Their owners must retain existing metadata
when the complete derived content is identical. A changed source-derived body
must still be regenerated and every existing stale-content assertion remains.

This is a generation and source-consistency gate. It cannot replace runtime,
worker-image, owning E2E, mounted, recovery, cold reconstruction or independent
review gates. In particular, the separate W2 closing-owner failure remains a
runtime defect to diagnose; a source inventory pass cannot discharge it.
