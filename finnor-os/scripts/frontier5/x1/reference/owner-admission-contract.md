# A-semantic-owner-admission, pre-owner-code development contract

Trigger: an authenticated PE Work with an authorized original source snapshot,
standing mandate and Core document versions containing the exact original bytes.
The source registration identifier is compared to the existing PE Deal's
source-system/external-id identity at an authorized S1 world cut. A same-name
Deal with a different source identity is not a match.

Expected transition: a distinct checker rereads those original bytes and the
authorized canonical/current snapshot. Only accepted, complete, unambiguous
mapping witnesses can use Core Document and PE evidence-link owners to attach
evidence; the returned mapping reference contains the actual persisted
DocumentVersion and evidence-link IDs, not a proposal ID. S1 still decides
belief state. A source with no exact canonical Deal, missing consent, incomplete
page coverage, a conflicting quantity, stale world revision or forged supplied
check receives no settled mapping/effect. Earlier document versions are retained.

Credible regression: matching on a Deal name, accepting a receipt the producer
supplied, treating Core Document creation as canonical mapping, linking an
unrelated evidence version or using a stale/revoked world cut. The offline
JSON checker and source decoder do not detect SQL tenant/owner link failures.
This case belongs to authenticated canonical S1/PE owner readback, not another
producer unit test. No live receipt exists at this pre-code cut. Rerun the
owner case only after the registered 1.5 GiB disk floor allows the stack.
