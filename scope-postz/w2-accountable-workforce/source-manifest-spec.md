# Source-manifest driver contract

This specification precedes the driver.

The driver resolves only its own checkout, reads Git identity and source bytes, and writes one new immutable manifest under this lane's evidence directory. It must fail on a missing Git object, unreadable selected source, timeout, existing output or an output outside that owned directory.

Select versioned source/configuration/declared assets and task-owned source records, not node_modules, build outputs, environment credentials, raw participant evidence or generated manifests. Preserve sorted path/byte/hash identity, current commit/tree, staged and unstaged path identity, runtime identity and actual capture time. Never output environment values or source contents.

Independent checking compares named file hashes with the platform SHA-256 command, confirms the recorded Git objects through Git, and confirms a second invocation cannot overwrite an existing manifest. This helper proves source identity only, not installed behavior, qualification or clean source.
