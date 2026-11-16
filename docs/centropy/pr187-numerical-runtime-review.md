# Numerical runtime and owner continuation review

Reviewed source: `619a1d1cb3c2fc5c683dcd582bba52c01325468d`.
Tree: `dd0ab12d2d63367d4e922d878accc83aa10debc0`.

## Failure model before implementation

Actions bot comment 6925258861 reports universal run 43924478095, attempt 1,
required-pr-verdict job 133514962452, failure. The Actions API binds the run
to this repository, PR 187, its current branch and the reviewed head. All
non-reporting jobs have completed. The S4 owner/replay job 133503331011
retains a real NUMERICAL_FAILURE from the S5 allocation producer:
PINNED_BACKEND_VERSION_CHANGED. Its recorded backend is Python 3.14.4,
NumPy 2.3.3, SciPy 1.16.2 and HiGHS 1.8.0. The existing allocation adapter
requires Python 3.12 in addition to those three exact package versions.

The workflow installs exact package versions into the runner's unpinned
python3 environment. The test correctly refuses this runtime. Prepare the
existing Python 3.12.13 scientific environment using the already pinned uv
container and the existing hash-locked dependency population. Verify the
actual Python/package/HiGHS versions before owner execution. Preserve the
adapter's refusal, original owner/replay cases, their finite limits and the
required gate. A setup success alone does not qualify the owner path.

Before changing the workflow, extend the existing process verifier to reject
an unpinned interpreter, unhashed dependency installation, an omitted backend
identity check, a conditional owner job, or missing original owner execution.
Run its damaged-workflow controls, then the unchanged complete S4 owner/replay
suite with the prepared runtime and retain actual source/result hashes.

The first local replay refuses before any case because tsx's CLI cannot bind
its auxiliary IPC socket (EPERM). Use Node's supported tsx import loader in
the outer launcher and the existing cold replay child. Keep the separate cold
process, exact same script, input, environment, output bound and 30-second
deadline. No owner assertion is changed. Retain this failed setup attempt.

The next attempt reaches embedded PostgreSQL startup and fails before migration.
A direct startup with its actual logging reproduces PostgreSQL's FATAL refusal
to create its default Unix socket (EPERM). The fixture already connects by
TCP. Use the same loopback-only TCP/no-filesystem-socket configuration as the
existing V3/W2 native fixture. Keep authentication, migrations, restricted
application role and every original scenario. This transport repair grants
no access to any existing database or provider.

## Current product acceptance boundaries

W2 run 43924457361 on the reviewed source passes the original exact,
before-exact, wrong-amount and wrong-payee episodes. Wrong-receipt job
133503274973 fails before settlement evidence with observed SQLSTATE 40P01.
The full five-episode comparison remains OPEN. Its lock-order hypothesis
requires a fresh real PostgreSQL reproduction and original negative episode;
earlier unpublished local experiments were lost during workspace maintenance.

Z0 run 43924457484 on this source passes M00 and fails the original mounted
institution display and reload-stability cases. The company projection
returns 504 while the application projection is READ_READY. The remaining
unrun cases do not establish phase acceptance.

The dependency gate still reports bincode 2.0.1 / RUSTSEC-2025-0141 and
paste 1.0.15 / RUSTSEC-2024-0436. No suppression or unverified native-proof
dependency substitution is part of this correction.

Z0-Z5 and W1-W3 still require their complete relevant source, installed-owner,
protected-effect and measured-business evidence. W4/W5 governing implementation
was unavailable in reviewed published/supplied sources. No overall pass,
zero-P0/P1 judgment, phase completion, merge or deployment follows here.

## Verified S4 correction

The complete original S4 owner/replay suite passes all 39 cases, zero failures
and zero skips, on local commit `2710066640c86004a29360b63b497cbb0342b867`,
tree `886c3d64ba11510a86d77ef11446b407675c6c05`. It ran from 20:57:12 to
21:00:19 UTC on 16 November 2026. The formerly failing operating-profit case
now reaches its original S5 allocation comparison; the separate cold process
matches the retained original program and certificate. All original privacy,
source/rights, liability, exhaustion, numerical-fault and no-effect cases pass.
The result file SHA256 is
`06b404a0ed39c4115276e493ce469a552c183b294bff7235cbda315684d68d42`.

The retained failing hosted artifact 14256291545 has ZIP SHA256
`326b9a96e0c211946bfa66bcf6f3cfe2204aa3c8ee617018e66660d395641cdd`.
It contains 38 PASS / one FAIL, with Python 3.14.4 in the rejected backend.
The new environment actually reports Python 3.12.13, NumPy 2.3.3,
SciPy 1.16.2 and HiGHS 1.8.0. No numerical pin or refusal was weakened.

The complete affected S4 TypeScript closure, 83 release cases, eight CI process
cases with 18 damaged-workflow controls, pinned actionlint 1.7.12, mutation
inventory and all 16 official generated-input generation/read-only checks pass.
CI process receipt SHA256:
`984ffa81bdf4057a3edc6028f544dd093952ce817611817631559d9a0616e0b1`.
Workflow validation receipt SHA256:
`3ae19c93c7ee22b95ae79645897ab57b0b0b3f70b2e33bc904d82334b707ab6a`.
Only this evidence section differs from the S4-tested source tree. Hosted
acceptance must run on the next published head; these checks do not close Z/W.

Reviewed receipt identity: (`universal-pr-verdict`,
`619a1d1cb3c2fc5c683dcd582bba52c01325468d`, `43924478095`, `1`).
Duplicate deliveries of that receipt require no additional review or notice.
