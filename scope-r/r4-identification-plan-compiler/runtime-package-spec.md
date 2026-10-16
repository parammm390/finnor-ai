# Final runtime package, registered before edits/build

The committed worker final stage contains Node, not either scientific Python
runtime. Add two isolated versioned Python stages: 3.11.15 for the complete
hash-locked y0 environment and 3.12.13 for the unchanged S3/S5 numerical pins.
No shared NumPy/SciPy upgrade or R1 dependency is introduced. Preserve native
flock, canonical source layout, worker entrypoint and signals.

Final stage must contain both interpreters, their separate environments,
original producer/checker/supervisor, locks and source-custody files. In-image
checks must import each installed runtime, verify actual version/source pins,
then inspect the installed inventory. Add the R4 lock to the existing API
file-tracing contract so a built route cannot attest an absent method lock.

Before publication, actual image construction and the final-stage native smoke
are mandatory for image qualification. The current local host has neither
`docker` nor `podman`, with 1.7 GiB free. This is an unpassed local packaging
gate, not protected-domain blockage and not a reason to claim an image PASS.

Selected local commands: `npm --prefix finnor-os/apps/api run build`,
`python3 finnor-os/scripts/r4/package-runtime.py --python <locked-r4-python>
--output <fresh-private-runtime-manifest>`, `npm run lint`,
`npm run workspace:check`, and supported affected source/security/queue checks
resolved from actual scripts. API build has a 300-second command bound; root
build has a 300-second bound after checking remaining space. Failed builds and
unavailable image tools remain separate from code-level assertions.
