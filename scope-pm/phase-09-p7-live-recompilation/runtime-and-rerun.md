# Restricted native P7 replay

Ordinary analytical correction only. No M3/M4/M2 completion generation, full
owner graph, S5 clearing, S6 dispatch, P5 drift join, mounted auth or admission.
Nine normative fields exist; unsupported owner transitions are not certified.

From `finnor-os`:

```sh
npm run db:bundle
npm run typecheck
node node_modules/typescript/bin/tsc -p scripts/p7/tsconfig.json
FINNOR_P7_EVIDENCE_DIR=/absolute/fresh/evidence \
  node --import=tsx scripts/p7/run-native-e2e.mts
FINNOR_P7_START_HISTORY=EXACT_PUBLISHED_S7_INTERRUPTED \
  FINNOR_P7_EVIDENCE_DIR=/absolute/fresh/upgrade-evidence \
  node --import=tsx scripts/p7/run-native-e2e.mts
```

Embedded PostgreSQL requires its authentic native postinstall/rebuild, including
ICU symlinks. `fs-ext` requires its native build. Backend dependencies are local,
not peer symlinks. Runtime is Node22.22.3 on Darwin arm64; protected Linux
confinement is NOT_RUN.

Latest upgrade run: `evidence/native-17-http-upgrade`. Six selected PASS, source
unchanged and present. It includes actual signed-bearer HTTP submit/read/current
projection through Company Brain with `AUTH_DEV_BYPASS=0`. Anonymous requests,
forged identity headers, invalid signatures and foreign principals are refused.
`evidence/native-15-http` retains the absent-dispatch HTTP 404 red.

The upgrade observes a real blocked SQL transaction, kills/reaps only
its owned child, checks rollback and completes the authentic forward registry.
The intake crash observes a real committed Work input before SIGKILL and adopts
only the immutable original intent and exact canonical input/event. It does not
test S6 lost acknowledgement or the manifest-commit crash window.

Stopped generated clusters may be compressed using
`scope-pm/completion-c/archive-owned-p7-database.py <absolute/native-case>`.
Every file byte is verified against the archive before its generated original
is removed. `database-archive.json` gives the archive digest and restore command.
Raw test outcomes and earlier source cuts remain retained.

Costs: observed local times/attempts and receipt identities only; dollars,
human/preparation/cleanup and whole-host resource compliance are not reconciled.
Experimental SQLite and pg parallel-query warnings remain observed.
