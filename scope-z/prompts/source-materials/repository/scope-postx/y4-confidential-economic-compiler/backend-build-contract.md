# Native backend preparation contract

This is a task-local source build, not provisioning or production qualification.
No private function, input, grant or protected corpus is used in this step.

- Upstream MP-SPDZ tag v0.4.4 resolves to
  `113c4e47dd94bca9ecab029d2f0abe649bea5c52`.
- Native target: `mascot-party.x`, the actual `Share` dishonest-majority
  malicious field machine. `Share` inherits an n−1 threshold and adds MACs,
  MASCOT preprocessing and active checks.
- Supported initial native modulus representation: two 64-bit limbs.
- Current accepted engineering profile: malicious SoftSpoken OT through pinned
  libOTe / cryptoTools, not a trusted dealer. The initial KOS15 build refused
  secure execution and is rejected; `security-build-deviation.md` retains the
  failure and remediation. No `-DINSECURE` workaround is admitted.
- No INSECURE, NO_SECURITY_CHECK, passive-only or fake preprocessing build.
- One build process group, 900-second initial build deadline, 2 GiB virtual
  memory per compiler process and one compilation at a time. Aggregate limit
  remains inherited. A resource failure is retained, not qualified away.
- Task-local Ubuntu noble/main and noble-updates/main packages are downloaded
  using authenticated apt metadata and extracted without system installation.
  Final lock must retain exact versions, archive digests and native dependencies.
- Source configuration is retained at
  `/home/factory-user/y4-tools/mp-spdz/CONFIG.mine`. Optimization/debug changes
  do not disable cryptographic checks. CPU architecture is an explicit local
  build assumption, not portable-image qualification.

Historical initial command (not acceptance of that initial build):

`cd /home/factory-user/y4-tools/mp-spdz && ulimit -v 2097152 && /usr/bin/time -v make -j1 mascot-party.x`

Retained output: `/home/factory-user/y4-delivery/backend-build-001.log`.
Acceptance: actual source-built executable, resolved dynamic dependencies,
security-relevant configuration/source audit, exact binary/config identities
and bounded real multi-party execution. Compilation exit zero alone is not
private computation acceptance.

Protocol documentation and source read: `README.md`, `License.txt`, `CONFIG`,
`Makefile`, `doc/networking.rst`, `doc/security-fixes.rst`,
`doc/runtime-options.rst`, `doc/preprocessing.rst`,
`Machines/mascot-party.cpp`, `Machines/SPDZ.cpp`,
`Processor/FieldMachine.hpp`, `Processor/Input.h`,
`Processor/PrivateOutput.hpp`, `Protocols/Share.h`, `Protocols/SemiShare.h`,
`Protocols/MAC_Check.hpp`, `OT/OTExtensionWithMatrix.cpp`.

BSD-3-Clause and inherited Bristol/KU Leuven notices permit redistribution
subject to notice terms. Upstream requests commercial/scientific use reporting;
the delivery must retain this obligation without sending unauthorized contact.
Transitive dependency licences remain to be inventoried.

Security fixes explicitly require binding MAC key to setup/OT state and deleting
a failed key. Never reuse task session state after abort. Use fresh participant
session directories and no file preprocessing. TLS certificates authenticate
the actual fixed participant set; their provisioning is local disposable only,
not new production signers.
