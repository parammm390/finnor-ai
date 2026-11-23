# Supported browser provenance interface gap

Status: **UNKNOWN, blocking mounted/full/cold qualification**. No browser
metadata, attach, navigation, page, auth, storage or tab-enumeration operation
has been performed for this investigation. No browser/daemon repair or alternate
automation API is permitted.

The actual bundled `agent-browser session info --help` describes
`session info` as “Show daemon, launch, and restore diagnostics”. It documents
the assigned session/namespace selectors and JSON output. It does **not**
document an existing-session-only, no-daemon-launch or no-browser-attach
guarantee. The inspected skill likewise gives no such guarantee. Consequently
the conditional nonlaunching metadata grant cannot authorize that query.

The help also does not define fields proving an observed visible/headed window
or external launch lineage. A `--headed` argument, an assigned endpoint, a
requested launch configuration, and hand-authored JSON booleans are not that
proof. Guessing `launch.headed` or similarly named fields is unacceptable.

## Required independent binding, proposal only

The Desktop/browser owner needs to expose a supported read-only existing-session
metadata export with documented nonlaunching behavior. It must bind the actual
browser PID/start identity, actual window/headed state and owner launch lineage
to the assigned session and endpoint digests. Its origin must be verifiable from
the browser owner, not a receipt invented by this campaign. Consume only that
documented schema, retain its digest, and recheck freshness before interaction.
No such schema or command is invented here.

Until that interface is established, `agent-browser-client.mjs` emits UNKNOWN
without issuing a browser command. `cdp-browser.mjs --provenance-only` records
the interface gap, not metadata or eligibility, and exits 2. The native bridge
refuses before PostgreSQL/API/worker startup. The complete participant and six
original mounted DOM predicates remain implemented behind this fail-closed
gate; they have not run. Browser provenance is not human, field, protected,
comparison, economic, CPU or performance admission.
