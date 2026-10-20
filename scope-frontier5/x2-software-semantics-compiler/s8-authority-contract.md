# X2 capability admission contract, before operation-port code

The existing S8 lifecycle owns the journal and authenticated actors. X2 adds a
closed application-operation payload and consumer, not a second catalogue,
generic callable-code admission or an execution-authority flag.

## Failure model and independent expected results

- The candidate owner cannot evaluate or promote its own model.
- Evaluator and promoter must be distinct principals and distinct Ed25519
  public keys. Different keys for the same principal are insufficient.
- A principal cannot obtain both roles by using separate actor tokens.
- Proposed model, lawful evidence, schema, grammar, checker, runtime, dependency
  closure, validity domain, original resource envelope and registered case set
  must match their retained preimages. Missing or changed coverage is UNKNOWN
  or refused, never an accepted empty proof.
- Admission requires the independently signed registered result, a distinct
  promoter, no false verification or authority violation, current source pins
  and an unexpired domain. The consumer repeats current-use checks.
- Journal replay cannot turn revoked, expired or substituted knowledge into
  current authority. Role credentials and failed cases do not disappear on
  restart.
- Ordinary disposable model admission never authorizes protected execution.
  Reviewed protected-domain admission remains refused without the actual
  independently governed contract and authority.

The native verification case must retain the authenticated proposer,
evaluator, promoter and consumer command chain through the existing S8
service and journal. Same-principal/different-key and actual self-promotion
negatives must reach the authority check, not an earlier source, schema or
unrelated transport refusal. A separate, valid positive admission and current
consumer read prevent an all-refusing implementation from passing.

The policy-level principal-separation correction is independently useful but
does not itself qualify X2, installed S8 operation admission or protected
activation. Those cases remain unexecuted until the new operation payload and
native driver exist.
