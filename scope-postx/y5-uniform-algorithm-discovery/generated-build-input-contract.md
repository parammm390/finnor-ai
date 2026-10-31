# Generated Next declarations and source closure

Registered before repair. The actual generator failed while following the
builder's `next-env.d.ts` filename literal into absent `.next/types/routes.d.ts`.
Next's installed TypeScript guide identifies `next-env.d.ts` as generated build
state, not editable first-party source. The installed builder already records
its generated type-input changes separately.

Exclude only the two known Next-managed declaration files from filename-literal
discovery. Do not ignore missing runtime imports or arbitrary `.next` paths.
An actual source import of a generated declaration must fail closed rather than
silently become an unpinned runtime dependency. Keep all owned source files,
relative imports, literal runtime assets, lockfiles and the existing self-hash
rule. Hash the complete final inventory with at most sixteen concurrent reads.

The prewritten `verify-source-generation.mts` records the original failure,
then runs the same actual generator and check mode after repair. It requires
the real loaded source boundary to accept all emitted pins, no generated Next
declaration in the source inventory, and the owned native/typed owner assets.
Every input, command outcome, source identity and rerun path is retained.

The UI dependency cleanup separately keeps its root value stable by scalar
identity, makes the form reset callback stable, and declares every refresh and
identity-effect dependency. It must not clear drafts on equivalent-root renders
or lightweight polls. The existing mounted browser oracle checks two real polls,
draft retention, scope changes and late-response suppression. Removing a hook
suppression is not a mounted-browser pass.
