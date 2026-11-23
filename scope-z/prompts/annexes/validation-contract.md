# Finite authoring validation, specified before assembler implementation

This is a failure-first pack contract, not a product test or protected oracle.
The implementation must exercise the complete offline assembly boundary. Do
not add retrospective unit tests for product code.

1. A valid cold input set reconstructs six seeds deterministically, with exact
   full PRD/common/prompt/skill bytes and complete earlier Z0 seeds.
2. A changed, truncated, missing, duplicated, or path-substituted product-lock
   member fails before publication. Check all 20 members, not just the PRD.
3. A changed source commit/tree, historical draft, supplied fragment, reconstructed
   X join, skill body, license, or source snapshot fails its corresponding receipt.
4. An active unresolved field fails. Mathematical notation, quoted historical
   prompts, ordinary code examples and documented template syntax do not create
   false positives. Missing or duplicated active headings or `/goal` fail.
5. Every phase has its own output, bounds, native seam, A–J, final seven labels,
   model/permission limits, fixtures and separate qualification states.
6. Dependency assembly is acyclic. Z1–Z5 each embed the full Z0 seed verbatim;
   no phase consumes a sibling implementation or recursively embeds peers.
7. Byte-sliced verification proves every framed payload and digest, including
   Unicode, trailing newlines and data containing apparent boundary syntax.
8. Missing final bytes, altered seed bytes, incorrect lengths, wrong dependency
   ordering, a missing companion file or an omitted mandatory read fail.
9. Absolute paths, traversal, empty/dot components, Windows separators, symlink
   files and symlink parent substitution are rejected. Only authorized pack
   outputs may be written. No output-root override, shell evaluation, phase
   launch, network fetch, controller write or lock rewrite exists.
10. A failed check does not repair, erase or replace the failing evidence.
    Failure receipts are content-addressed and retained. Reassembly must not
    overwrite an unrecognized or concurrently changed output.
11. Source snapshot copies equal their repository preimages at capture. Historical
    partial-read receipts remain partial; copying a full file is not claiming
    that its behavior ran or every line was independently inspected.
12. Build twice and compare byte-for-byte. Check mode performs no successful-run
    writes. Run self-check without product services, credentials or API effects.
13. A forged replacement snapshot plus a newly hashed capture record must still
    fail the original Git-blob binding. Regenerate actual source excerpts and
    reject omitted snapshot files or altered excerpt/range claims.
14. A FIFO, directory or growing nonregular input must not hang the finite
    auditor. Reject it without blocking or unbounded reads.
15. Retained failure receipts must themselves be indexed and digest-checked,
    not merely mentioned in a later successful report.

Self-check records case names, actual dispositions, assembler identity, product
lock identity and the complete validated-input inventory digest. A changed
prompt, family specification or other input requires a new self-check before
publication. It must not label this exercise internal product completion,
installed product reconstruction, mathematical qualification, protected
admission, equipped increment, operational/financial 100× or activation.

Existing checks to inspect, not silently run here: root Playwright E2E and
workspace typecheck/generated-contract checks. New checks in this authoring
task are the assembler's offline end-to-end reconstruction and mutation cases.
No runtime verification was authorized for this prompt-only task.
