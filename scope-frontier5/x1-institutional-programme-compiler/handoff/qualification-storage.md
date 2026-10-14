# Finite qualification storage and administrator verification

The qualification collector writes a private append journal. The cursor contains
a relative journal pointer and an initial preimage digest. Chained, framed,
dictionary-compressed changes preserve every exposure and observation without
rewriting the growing history. `readQualificationCursor` reconstructs the same
state and rejects incomplete or altered frames. Existing JSON cursors keep their
original counters and a retained preimage when first converted. A partial frame
requires explicit operator inspection; the reader does not truncate or reset it.

Repeated semantic snapshots are referenced once while every physical poll keeps
its identity/response digests, read time, visibility witnesses and disposition.
Row order, duplicate multiplicity, acceptance, material values and owner commit
times remain part of the semantic identity. The native observer's per-read
`x1_observed_at` remains in physical history. UNKNOWN and failed reads remain
retained. Acknowledgements may share the next read-only exposure write; every
exposure is durable before physical work. An interrupted acknowledgement stays
uncertain. Actual native deliveries remain separate from conservative idle ticks.

Administrator `collect`, `live` and `replay` commands reserve new report bytes
under the original cursor lock before writing their files. Initial startup
evidence is charged before the first physical call. Compact reports reference
the original journal and unique immutable snapshots; past bytes are not charged
again. The original 64 MiB limit and all original registration/phase limits stay
fixed. A refused limit change leaves the original journal untouched.

Run from the source checkout's `finnor-os` directory after the full public
`qualification-contract` command has produced its `full-contract` directory:

```sh
node --max-old-space-size=768 --import=tsx \
  scripts/frontier5/x1/qualification-storage-cases.mjs \
  /absolute/private/fresh-storage-evidence \
  /absolute/private/qualification-contract-evidence/full-contract
```

This finite command uses public transport fixtures and published RFC 8032 test
material. It records a real thirty-second transport run, same-cursor resume with
a real refusal and changed/duplicate rows, a synthetic storage horizon, corrupt
and incomplete frame challenges, and four actual administrator commands. The
registered bound is 180 seconds, 768 MiB Node heap and 64 MiB output. Run it
serially with service/build verification. It does not install a trust policy,
create a protected signer/grant or establish business truth. The horizon encodes
100,800 probes across 720 finite slices; actual elapsed live days remain zero.
Capacity evidence applies to those declared inputs. Materially growing histories
or larger selector populations still consume the same grant and can be refused;
no qualification threshold or cost denominator is narrowed to make them pass.

The genuine owner regression remains:

```sh
node finnor-os/scripts/frontier5/x1/verify.mjs --stage owners \
  --case qualification-execution --evidence /absolute/private/fresh-owner-evidence
```

That separately reaches authenticated API, queue, worker, independent checker,
S1/P1/S5/S7, interruption/reconciliation and native completion. Neither command
establishes protected custody, the full unseen institutional population, actual
thirty-day execution, seven elapsed unattended live days, S8 admission, deployment
or operational/financial gains. Missing prices, human work and aggregate memory
remain unknown.
