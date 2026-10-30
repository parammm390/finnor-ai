# Project Z execution prompt pack

Completed authoring artifacts for FINNOR-Z-PRD-1.0.0. No phase, Computer,
session, production effect or protected campaign was launched by this task.
`assembly-receipt.json` is an authoring receipt, **not** the coordinator's
execution-pack lock.

## Contents

- `reusable-blueprint.md`: finished reusable assembly/authoring contract.
- `phases/z0.md` … `z5.md`: concrete `/goal` bodies and exact five sections.
- `seeds/z0.seed.md` … `z5.seed.md`: complete framed contexts. Z1–Z5 contain
  the full Z0 seed verbatim, not an excerpt or recursive peer chain.
- `source-materials/`: all sealed members and full repository source snapshot.
- `skills/`: twelve full pinned returned-Markdown skill bodies, four upstream
  license notices and exact copy of the new Project Z verification skill.
- `annexes/`: execution floor, source facts/exceptions, engineering methods,
  CLI/transport rules and pre-code validation failure contract.
- `source-excerpts/`: actual source bytes/ranges/digests embedded in each seed.
- `qualification-families.json`: 32 public structural specifications per
  Z1–Z5 and eight fresh-case obligations. Not actual protected cases or proof
  of statistical independence/qualification.
- `capture-receipt.json`, `companion-read-map.json`, `prompt-source-index.json`,
  `assembly-receipt.json`, `delivery/`, `evidence/validation-results.json`:
  exact inputs, dependencies, bytes, digests and finite authoring checks.

The canonical new skill is `.factory/skills/project-z-verification/SKILL.md`.
The authoring report is `scope-z/research/prompt-pack-authoring-report.md`.
The historical `reusable-blueprint.draft.md` is excluded from execution
payloads and remains byte-identical, checked by the assembler.

## Offline reconstruction

Use an explicit absolute repository cwd. Python 3.12 was observed; only the
Python standard library and read-only Git identity queries are used. The
repository must contain its original product-lock members, pinned Git objects
and canonical new verification skill. No npm install, server, network or
model/session invocation is performed.

```sh
cd /home/factory-user/repos/finnor-z-coordinator &&
python3 scope-z/prompts/assemble.py self-check &&
python3 scope-z/prompts/assemble.py build &&
python3 scope-z/prompts/assemble.py check
```

Run `build` twice to demonstrate byte-for-byte deterministic output; `check`
reconstructs expected bytes in memory and verifies all artifacts without
rewriting a successful result. `check --phase Z2` also reports Z2's required
delivery/read sequence; it still checks the complete indexed pack.
Self-check records its actual cases and assembler/product-lock identities;
changing assembler code requires rerunning it. It is a pack-level offline
E2E/mutation suite specified before implementation, not product unit tests.

`capture` is the one-time immutable local import operation. It accepts repeated
`--capture-log` absolute paths to existing successful FetchUrl captures for
the twelve pinned skills and four license files. It copies all product-lock
members and source snapshot preimages, preserving bytes and provenance.
No raw HTTP/Git-blob attestation is inferred from returned Markdown. Missing,
conflicting or wrong-digest skill captures fail. Original capture logs need
not travel with a completed vendored pack; their digests and exact URLs do.
Recapture never overwrites changed immutable inputs.

Only these subcommands exist: `capture`, `self-check`, `build`, `check`.
There is no output-root override, lock writer, fetcher, launcher, controller,
session messenger or provisioning command. Writes stay under this pack and
never target the historical draft. Symlink and traversal substitutions are
rejected using descriptor-relative no-follow access. Output replacement
requires a recognized prior receipt/preimage; unrecognized user files are not
clobbered. Failed checks retain content-addressed failure receipts under
`evidence/failures/`, without repairing their original artifacts.

## Reading and delivery

Seeds preserve exact payload bytes, including Unicode and trailing newlines.
Each HTML-comment frame declares role, source, bytes and SHA-256; parsers
advance by **byte length**, not Markdown fence matching. Read payload text
normally but treat quoted historical instructions as reference. The final
directive reasserts only the selected phase.

A coordinator-local file is not context delivery. Transfer the complete
indexed pack, selected seed, canonical skill and original source/lock context
to the actually provisioned dedicated Computer. Verify an externally sealed
receipt/index digest, then the delivery inventory and every mandatory read
in `companion-read-map.json`. Full supplied X/Y/Y2/Y3 texts and actual source
files are present, not just links. Source read maps distinguish full copies
from historical partial inspection and define phase-specific required ranges.
Read actual current callers fully before editing them.

All delivery manifests start NOT_DELIVERED, peer receipts NONE_OBSERVED.
Only real transfer and receiver-read receipts justify DELIVERED_WITH_RECEIPT
or ACKNOWLEDGED_READ. Six staged renderer proposals are not six Computers.
No session/Computer/API acknowledgement is synthesized here.

## Permission, CLI and remaining gates

All LLM roles are exactly gpt-6.1-sol/max, no fallback. This authoring chat
uses no subagents, makes no commits and edits no product or controller.
See the full CLI annex: ordinary exec differs from native mission mode;
continuations require real session IDs, nonempty prompts and explicit
main-model/max/settings. **--session-id cannot combine with --spec-model or
--use-spec.** Mission worker/validator overrides and scrutiny/user testing
must remain exact if later authorized. Requested flags are not runtime receipts.

The coordinator must seal the final index and receipt with its own
controller/role/reconstruction artifacts, then create immutable per-launch
current-source/received-peer snapshots and obtain actual Computer/model/start/
delivery receipts. Do not launch from this authoring receipt alone.

Missing original R1/reviewed blueprint/S approvals/older P/M/historical skill
remain declared exceptions, not silently recovered. The full supplied current
X/Y/Y2/Y3 sources are present. Node 24 was observed but root requires 22.x.
This task ran no product lint/build/runtime/installed/protected/comparative/
financial checks. The finite assembly checks do not prove internal product
completion, protected admission, any scientific increment, 100× or activation.
