# Governing and engineering source custody

Retained governing bytes have been rehashed against the supplied identities:

| Source | SHA-256 |
|---|---|
| POST-Z PRD | `86eb185341f87ee3e54d1cbdb8f12657465322ff1d5385bde9b1db99f619ebbe` |
| Reviewed blueprint | `9315722ef05f2febf2fde507456968a3023c661510f51646b12c6335603f727a` |
| Full R1 supplied source | `b0ba121afba847ef7108208688eb39c4270372f2260f894069f772c2e2ab6352` |

`sources/pstack-custody.json` records 45 exact-pin files. The additional supplied
Ponytail, Cursor and OpenClaw pins were resolved and their applicable texts read
at the current review cut, not retroactively before the initial implementation.
`sources/engineering-custody.json` records seven retained documents/licenses,
their original paths, exact byte lengths, Git blob identities and SHA-256.
All seven local copies match. Ponytail's compact source is renamed so that a
retained foreign `AGENTS.md` does not become a local instruction file.

Applicable practices are minimum complete implementation, canonical owner
reuse, explicit boundaries, structural simplification and nonvacuous proof at
the owning boundary. D013 removes a redundant reader counter and scopes local
drafts through the existing private-request owner. Native rejection proofs now
also count all recipient PATCHes, not just a key computed by the producer.
These are reviewed changes, not passed native predicates.

The retained MIT copyright/permission notices accompany the copied material.
No foreign model selection, delegation, test command, infrastructure operation,
deletion, publication or merge authority is adopted. No foreign code is a W3
runtime dependency. Their advertised benchmark numbers are not W3 evidence.

Reading these references is not a completed compatibility or security audit of
FINNOR's runtime dependencies. Original X/Y/Z equivalence, actual installed
dependency closure and separate reconstruction remain unverified.
