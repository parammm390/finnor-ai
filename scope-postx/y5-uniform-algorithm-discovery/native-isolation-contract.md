# Native OS boundary, before implementation

Closed ASTs and sanitized environment variables do not provide an OS sandbox.
The current independent guardian still permits a Lean process to read or write
unrelated host files and open network connections. The parent owns this slice
while the five isolated writers work on owner integration, Markov, packaging,
UI and generated contracts.

## Concrete change

Require the available Darwin Seatbelt sandbox for every Lean and leanchecker
child. Pin its policy as source. Deny networking and execution of other
programs. Permit reads of the verified tool root, the owned canonical scratch
directory and explicitly named OS runtime paths. Permit writes only to that
scratch directory and the null device. No unsupported-host or failed-sandbox
fallback to unsandboxed execution.

Preserve the independent guardian, process-group kill, exact original deadline,
output ceiling and physical-close witness. Open guardian receipts and scratch
markers without following symlinks. Report the actual sandbox policy digest.
Sample resident bytes for the caller process and its descendants independently
of the caller event loop. Label this scope and sampling explicitly: it is not a
hard kernel memory cap, an exact simultaneous peak, or full-episode accounting.
The full-episode aggregate peak, complete money and human time remain unknown.
Do not turn this partial meter into a qualification pass.

## Prewritten falsifiers

`verify-native-isolation.mts` uses only task-created public sentinels. Through
the actual native boundary, a Lean program must be able to read/write its own
scratch but unable to read or overwrite the outside sentinel or execute a
different program. Before implementation this observes the current escape.

A tiny preregistered native probe additionally exercises the same Seatbelt
policy directly: an ordinary control can connect to an owned local listener,
whereas the sandboxed probe must be denied. It must not contact an external
host. Its explicitly different probe executable is not a production runtime
admission. Retain source, inputs, child results and sentinel hashes.

Then re-run the full total discovery/kernel/same-definition E2E and existing
guardian fault/parent-loss checks on the new source cut. At most two
undiagnosed trials per predicate; retain every failure. Any policy or native
asset required by installed execution must enter the final source/runtime
closure. Assigned UI and production are untouched.
