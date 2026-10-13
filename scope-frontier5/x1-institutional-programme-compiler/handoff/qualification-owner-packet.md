# X1 protected population owner packet

Software entry: `finnor-os/scripts/frontier5/x1/qualification-admin.mts`.
Its supported commands are `plan`, `instantiate`, `launch`, `observe`, `resume`,
`replay`, `live`, `native-control`, `collect`, and `assess`.
`instantiate` appends authorized immutable Core originals and narrows existing
read rights through the ordinary source owner. No command creates protected
keys, protected grants, admission receipts or production authority.
The current packet is **NOT RUN** without the existing authorized custody assets.

The full generator control now requires each environment's independently
pinned `soakExpectedEnvironment` and `originalEpisodeCatalog`. Replay truth is
generated from every original byte version and newly frozen business branch;
soak truth is read from its separate custodian input. The generator emits
`public-original-episode-catalogue-draft.json`. Include each environment's
`originalEpisodes` in its public Work-input environment BEFORE the custodian
signs `publicInputDigest`. Each entry contains `tenantId`, `principalId`,
`workId`, `originalEpisodeId`, `originalGrantDigest`, and `originalDeadline`.
Native worker control and source setup compare these preregistered values with
actual authenticated Work/restricted SQL owners before starting. New original
business assignments may use their own preregistered parents; retrying keeps
the original assignment's parent and deadline. Missing or different catalogue
entries are refused, rather than adopted from current state.

For `instantiate`, add a `generatedInstantiations` pin to the private control.
Its file is an array of exactly ten objects `{environmentId, owner, control}`.
The owner is the registered local API origin/tenant/principal and existing token
environment-variable name. The control uses
`finnor.x1.generated-original-instantiation.v1`, with `publicPacket:{path,sha256}`,
`workId`, `purpose`, `expiresAt`, and `originals`. Each original contains the
existing `sourceId`, `grantId`, `documentId`, `parentVersionId`, and `sourceClass`.
The current source must be that original or the exact already-installed child
with its original parent, actor, bytes and installation metadata. Each step
retains an exposure/version/registration receipt. Repeating the exact control
after partial setup reuses its immutable version and ordinary grant IDs.

Source setup also requires an `allocationConvention` pin. The canonical digest
of its body must equal the signed protocol's `allocationConventionDigest`:

```json
{
  "schema": "finnor.x1.command-lifecycle-allocation.v1",
  "lifecycleOwner": { "tenantId": "EXISTING_TENANT_UUID", "workId": "PREREGISTERED_WORK_UUID" },
  "intervalAccounting": "CONTAINS_COMMAND_COMPONENTS_DO_NOT_SUM_ELAPSED"
}
```

Those UUID labels are required owner inputs, not issued identities. The chosen
owner must be in the signed original population. Successful and failed setup
write one physical command UUID through the existing S5/S7 lifecycle writer;
the containing interval is not added to its component elapsed time. The setup
cost receipt retains money, human time and aggregate memory as unknown. If no
valid preregistered owner exists, the command retains the precise meter gap
without creating a parent. Complete priced lifecycle custody remains required
for qualification.

`collect` reads all original durable cursor segments. It retains raw receipts,
folds repeated polling by maximum within-snapshot claim multiplicity, and keeps
refused claims in the denominator with zero matching credit. Native S1 readers
verify actual current canonical ownership and exact live evidence attachment;
native completion readers compare current/origin intent and actual canonical
fields. Snapshot collection remains unsigned and grants no qualification.

Development evidence: source setup interrupted after four actual registrations
and resumed with the same version/grant IDs; actual preregistered parent binding
and deliberate wrong-parent refusal; twelve normalized mappings, one native
Request completion, archived-attachment refusal and one S5/S7 setup charge.
These are local owner proofs, not ten unseen institutions or complete horizons.

The independent qualification custodian supplies an existing trust policy and
its separately trusted SHA256, signed preregistration and ten signed oracle
ledgers. Each environment binds at least eight distinct supported system classes
and distinct application fingerprints, five randomization commitments, unseen
custody, complete replay journal and public Work-input digest. Freeze critical
cases and the full mapping/obligation/change populations before exposure. Oracle
and candidate execution isolation remains the custodian's verified responsibility;
the software does not infer isolation from filesystem paths.

Each oracle carries separate replay and live populations. The independent observer
signs cumulative packets with actual original source/runtime cut, checked claims,
canonical/provider completion witnesses, admitted-channel recognition times,
30-day replica coverage and separate monotonic seven-day live segments. All
original episodes, grants, deadlines, charges, failures and violations are retained.
Packet chaining rejects removal of duplicate material claims, episode cost/grant
resets and lower recorded peaks; historical false completion remains a veto.
Setup and validator costs require a separately signed lifecycle cost packet.
Unknown money, human time or aggregate memory cannot establish complete costs.

Store a private control JSON matching the strict
`finnor.x1.qualification-control.v1` schema. It pins absolute paths and SHA256s for
the registration, trust policy, public inputs, ten oracle ledgers, observation
packets and optional lifecycle costs, plus a private evidence root. Public inputs
carry only the registered local API origin, existing token environment-variable
name, tenant/principal, Work/input/grant handles and immutable idempotency key.
They contain no oracle mappings or supplied candidate. After launch, add the
actual accepted delivery-receipt pins to a new control for observe/resume; do not
change registered public inputs or mint a new request/grant to recover uncertainty.

Run from the reconstructed repository, using the installed Node runtime:

```sh
/usr/local/bin/node --max-old-space-size=768 finnor-os/node_modules/tsx/dist/cli.mjs finnor-os/scripts/frontier5/x1/qualification-admin.mts plan --control /absolute/private/control.json --trust-sha256 OWNER_SUPPLIED_POLICY_SHA256 --evidence /absolute/private/evidence/fresh-plan
```

Replace `plan` with the finite desired command and use a fresh evidence directory.
`launch` checks the real authenticated `/api/me` and sends registered handles to
the existing compiler API. `observe` collects candidate responses and does not
score their completion claims. `resume` re-reads the same accepted request/Work
before resuming. Repeated launch retains the exact original key. Actual test
services and physical workers must already be installed and authorized, with
auth bypass disabled; the independent observer retains that installation proof.
Protected oracle/provider observation and live service supervision are not
replaced by this candidate HTTP collector.

The replay owner advances only the registered 30-day journal. The live observer
collects seven elapsed days outside the coding session, records actual clocks and
remaining original episode resources, and resumes the same responsibility after
interruptions. Capture signed checkpoints to immutable private files; update only
their pins in a new control. Run `assess` to verify signatures, commitments, chain,
per-environment/per-phase rates, history vetoes and original cost envelopes.
The outcome is a registered-evidence assessment, not S8 admission or activation.

Acceptance retains 99% precision/95% recall for both material mappings and
supported obligations; 95% within original deadlines; 95% changes recognized
within 120 seconds of admitted-channel availability; zero observed forbidden
effects/disclosures/stale execution/false completion/silent contradictions/human
institution patches. Empty populations and incomplete horizons are unqualified.
Transport delay is reported separately. Original financial episodes retain
$100/900 human seconds/16 GiB/30-second initial response/3,600-second wall limits;
preparation retains 80 human hours/$10,000 per actor. Register separate aggregate
setup/replay/soak/validator envelopes and the allocation convention before exposure.

Receipt destinations: fresh private command evidence with `freeze.json`, finite
candidate outcomes or `assessment.json`, signed packet/oracle/cost input pins and
original failed attempts. Public hand-calculated scorer tests prove denominator
arithmetic only. Current protected custody, population, live clocks and actual
canonical/provider qualification evidence remain **UNAVAILABLE / NOT RUN**.
S8 admission, operational 100×, financial 100×/$100 million and H2 remain separate.
