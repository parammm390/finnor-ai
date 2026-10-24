# Principal artifact acceptance, before implementation

The existing recipient release is a checked local output opening, not yet the
complete POST-X principal artifact. Extend that owner, not another store.

Observable contract:

- A current recipient release contains the required common envelope and all
  eleven principal computation fields, derived from the persisted original
  function, actual checked protocol, consent/commitment rows and native
  execution receipts.
- Missing S8 admission, independent protected result evaluation, source truth,
  complete costs, institutional custody and production review remain explicit
  UNKNOWN bindings with the actual responsible owner. A supplied reference is
  not an issued owner receipt.
- The content digest binds the whole release and envelope except its own
  digest field. The existing recipient-private random opening nonce remains
  in that preimage. No output or unsalted low-entropy hash enters shared Work.
- Readback verifies both the stored row digest and the complete artifact
  digest. Foreign recipients and revoked/expired owners still fail at the
  existing owner/currentness boundary.
- The one final complete release contract uses the v2 discriminator. Earlier
  branch-local attempts do not establish a deployed v1 compatibility contract.
  No artifact grants admission, credentials or effects.
- Logical construction observations return only the specified result enum,
  actual artifact/check references and explicit gaps. Compiler failure,
  protocol abort and absent rights never map to financial INFEASIBLE.

Primary E2E owner: `recipient-release-and-native-consumer` in the existing
installed lifecycle. It must inspect the persisted recipient artifact,
independently recompute its complete digest and verify explicit missing-owner
bindings before the existing native consumer and revocation assertions.
This extends F1/E1 rather than adding a post-code unit test or test-only route.
