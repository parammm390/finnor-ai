# Evidence-chain packaging, before its implementation

Retained delivery/source archives total 1,614,732,649 bytes. Free space after
the current source native rebuild was 2,918,424,576 bytes. Nesting every older
successful archive in each new evidence archive duplicates already retained
bytes and can prevent the unchanged full installed extraction plus 512 MiB
reserve. Deleting old evidence or lowering that reserve is not allowed.

Use an explicit exact-report-SHA-bound previous successful evidence snapshot.
Independently read back its complete archive against its manifest. Package
new/changed raw evidence in a normalized delta with exact old preimages and
new postimages. Unchanged evidence remains in the named base, not reclassified.
Keep all older archives/bundles as separately hashed required references.
Do not omit raw failed logs, proof candidates, interruption receipts, protected
data or user work. No file is removed or relocated by this packaging mode.

Reject a changed/missing/unsafe base, wrong report hash, malformed archive,
member/hash/metadata mismatch or ambiguous preimage. Deliver the base, delta,
reference list and exact reconstruction rules together. A base archive's
historical qualification state does not become current qualification.
The final descriptor must name all parts; a delta alone is not a full packet.
