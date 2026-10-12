# Automatic institution updates — pre-code boundary contract

Use the existing Work, source-authority, P7 dependency, physical queue, S5 and
S7 owners. Change records are coordination metadata, not a second truth store.
An owner change is a trigger to re-read authorized inputs; its payload does not
supply a candidate, grant, action, completion receipt or replacement budget.

Credible failures to exercise through authenticated installed boundaries:

1. Source grant revision, mandate, exact Work input, identity/consent, canonical
   version or Document head changes without manual revise. Persist an event and
   a reconcilable physical job in the same owner transaction. Cancellation must
   stop later automatic submissions; a stopped user Work is not resurrected.
2. Duplicate event or death between producer acceptance and handoff recording:
   keep one immutable prepared request/idempotency key and adopt its same result.
   Never derive a fresh parent/key from the now newer compiler request.
3. A live compiler blocks overlap. Defer within the original deadline/counters,
   then re-read the latest completed parent and current owner inputs. Old claim
   token/fence/generation cannot prepare or publish a newer event.
4. Refuse expired/revoked/missing source authority and an exhausted original
   parent. Do not omit a prior source or reset attempts, acquisition counts,
   resource quantities, money/human accounting or the original deadline.
   Record the exact gap and preserve previous effects/costs/history.
5. Byte/cosmetic drift with unchanged checked meaning has no affected duty.
   Material change computes the typed dependency closure. Carry only genuinely
   unchanged duty intent and sealed creation witnesses; changed and unavailable
   duties retain explicit gaps. Do not reuse the analytical 256-node contract.
6. Attribute actual coordinator/compiler deliveries under the original parent.
   Charges use separate stable phase/ordinal domains; a coordinator must not
   alias a continuation charge. Meter failures stay explicit, never zero costs.

Required evidence: owner change and event IDs, live job/delivery/claim, exact
prepared input handles, same accepted next request on crash adoption, current
grant and Work reads, independent closure expectations, canonical observations,
original resource/deadline history, cost references and finite rerun command.
The source contract is not positive E2E or protected qualification evidence.

Finite read-only review confirmed two recovery defects before repair:

- Interrupt after PREPARED, cancel the compiler or Work, then reclaim. New
  acceptance must check cancellation and the actual update claim in its own
  transaction. A previously accepted request may still be reconciled.
- Commit the prepared key and lose its acknowledgement, or fail handoff
  recording after acceptance. Reconcile that exact key before terminal failure;
  retain uncertain preparation for bounded retry without another identity.

Both defects are repaired in source. SQL/runtime reproduction remains NOT RUN.
Preparation handles/time and an accepted next-request pointer are immutable.
Application default table privileges must not permit inserting event metadata.
