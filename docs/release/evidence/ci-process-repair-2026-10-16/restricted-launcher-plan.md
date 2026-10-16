# Restricted Linux launcher: preregistered repair

Source preimage: 69c0c211b8d9095defeae7d28f54b2efa0a22132. After repeated
specific descriptions/approval requests, the user instructed “Do it”; proceed
with that narrowly described software repair, not additional AWS permissions,
privileged containers, security-profile overrides or protected activation.

Observed target: native Fargate x86_64, kernel 6.1.186, Landlock ABI 2,
unprivileged user namespaces denied with EPERM. Retain the original probe and
failed/cancelled CI; neither is acceptance of this replacement.

Failure model before implementation: wrong kernel ABI; missing/changed helper,
runtime/library/manifest; symlink or writable root custody; extra capabilities;
root execution; arbitrary root/command/FD injection; host path/data/metadata
escape; cross-job access; remaining descriptors or credentials; process/network
creation; signal/setsid escape; owner death; Landlock ABI-2 truncation and
metadata gaps; inode/rename/link tricks; read-only P1 writes; lost CPU/memory/
call/deadline accounting; unavailable capability or Landlock; missing bootstrap
receipt; cleanup failure. All refuse, never fall back to unconfined execution.

Trusted setup may acquire exactly file capability CAP_SYS_CHROOT in a root-owned
fixed launcher, with caller UID/GID retained. It enters one hard-coded sealed
runtime root, drops all effective/permitted/inheritable capabilities, enables
no-new-privileges, Landlock and the existing strengthened syscall filter, closes
all setup FDs, then executes only its fixed Node runtime. No root or arbitrary
launcher arguments. No user namespaces, mount, SYS_ADMIN, setuid-root, task-role
changes or disabled outer profiles. Landlock ABI 2 alone is not sufficient:
the fixed jail hides host metadata; syscall rules close truncation/metadata
mutation and process/network/signal escape paths.

Finite verification: existing four S6 hostile executor scenarios, explicit
host metadata/truncate/permission attempts, independent kernel bootstrap receipt
(zero capabilities + no-new-privileges + Landlock), existing four P1 physical
supervisor scenarios with original 750ms deadline, existing installed R3/R4
owner cases and unchanged release gates. Preserve exact source/runtime hashes,
raw execution/physical/bootstrap receipts, omissions, cleanup and replay steps.
Use one credential-free bounded native Fargate verification of the actual
launcher before publishing a consolidated candidate. No production service or
database mutation for that verification. Keep software installation distinct
from protected effects, admission, economic and comparative-gain qualifications.

## Observed installed-context repair (batch 171)

All five installed S6 cases refuse CALLER before bootstrap: the direct Node
test supervisor is container PID 1. A live namespace init is a legitimate
parent, not an orphaned child; its exit tears down the PID namespace. Preserve
nonroot UID/GID, exact capability, unchanged-parent and PDEATHSIG checks while
accepting a positive parent PID including 1. Verify both child-supervisor and
PID-1-supervisor contexts using the same five actual E2E cases, explicitly
binding the helper's observed parent to the driver PID. No floor increase,
extra capability, init/security override or omitted case is justified.
