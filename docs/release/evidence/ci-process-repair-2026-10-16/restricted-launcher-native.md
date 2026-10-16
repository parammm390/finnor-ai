# Native launcher verification — 16 October 2026

Repair preimage: `69c0c211b8d9095defeae7d28f54b2efa0a22132`.
The existing combined R1–R8 / V1–V5 candidate is retained. No new PR.

Actual credential-free Fargate x86_64 verification compiled the exact C helper
with `-Wall -Wextra -Werror`, packaged the sealed Node 22.22.3 runtime, then ran
the actual S6 E2E driver as UID 1000 with the default outer security profile.
Trusted root setup compiled/packaged only; generated code had zero capabilities,
no-new-privileges, Landlock ABI 2 and the mandatory syscall filter. No task role,
application secrets, database access, added task capabilities or service changes.

All five cases PASS: positive calculation/private scratch; host metadata and
ABI-2 truncation/permission boundaries; secret/file/network/process refusals;
detached-child lifecycle with independent procfs census; time/output limits and
unsupported protected/hard-quota refusal. Original limits were not raised.

Final temporary task: `2e98edbc75d243f0a883b0f2f4e88544`.
Definition: `finnor-isolation-probe-a46ba6baf22640bf:1`, us-east-1.
Physical task STOPPED, exit 0; definition deregistered/deletion requested; its
exact log stream removed only after raw logs were retained. Cleanup succeeded.
No production service, database or AWS permission changed.

Loaded filter and expected filter SHA256 both:
`23623441a6dc37d4b809fb9e926e29c86f812523ce5a3a802bcafc4504849a92`.
Bootstrap independently records PID 664, UID 1000, capabilities 0,
noNewPrivileges 1, fixedJail true, landlockAbi 2.

Source freeze (paths relative to finnor-os):

| Path | SHA256 |
| --- | --- |
| packages/governed-execution/native/linux-launcher.c | 4309b3200190a895509b39428636968521ef3d3b4c7c4e0436523af32e3ffbfc |
| packages/governed-execution/src/executor-linux.ts | 6a0938097789c94363b434f7d1f23f5d0ef603e77c5bfca78682ba9d392ccbfe |
| packages/governed-execution/src/executor.ts | a19ba246f8c9f62640124ae7f2eb865c3326fc716d67aa34011a7b3e93efeeda |
| scripts/r3/package-linux-jail.mjs | 1bd991246c4cf89112db373ba603cec91eb4712d536dd74d056309c079a90083 |
| scripts/s6/run-executor-e2e.mts | 1148c041a2fe64e6581652d7ece12f4ff9b315bccbc32a36683414a158be71a2 |

Retained task artifact folder: `finnor-isolation-probe-a46ba6baf22640bf` in the
release chat's artifact root. It includes source/config freeze, exact AWS
operations, source-before/after records, all execution/bootstrap receipts,
independent process observations, raw paginated logs, cleanup and result.
Result SHA256: `945e4bf211d381ad214ca78f1314cc3a9c5550e7a2cd2b0c1d94b298938cc538`.
Reassembled compressed raw evidence SHA256:
`33d914f725f0a57d2d0134f190d083da66bacd8f90d47a24a56941722e32f72e`.

The earlier passing native run `finnor-isolation-probe-c7f18664218e480c` is also
retained. CodeRabbit then identified loaded-filter provenance and setup cleanup
issues; both were fixed before the final native rerun above. Follow-up review
raised 0 issues. The first review's buffer-overflow title was not substantiated
by its own analysis; the valid loaded-byte binding issue was repaired.

Local checks PASS: backend typecheck, generated contracts, relocated worker
imports/source custody, eight CI-process scenarios, four macOS S6 challenges,
four original P1 physical-supervisor challenges including the unchanged 750ms
deadline and explicit cancellation. These local receipts do NOT qualify Linux
P1, installed R3/R4 owners or production. The exact final image now executes all
five S6 cases before the existing P1/R3/R4 owner gates in PR and release CI.

Reproduction: build `finnor-os/Dockerfile.worker`, then run the existing
`bash scripts/release/smoke-worker-image.sh` with its documented exact release
metadata/disposable PostgreSQL prerequisites. The bounded native transport is
retained as `build-launcher-proof.mjs` and
`run-fargate-isolation-probe.mjs --launcher-verification` in the chat artifact
root; it validates project/Region/PAID status, freezes payload/config, uses one
unique task with a ten-minute controller deadline and always cleans up.

Production remains unreleased. Public frontend/API still report
`517003a4396bc8101a90be4b425ee01de9446740`. Existing authority preimage is already
water_retired/private_equity at epoch 6 since September; this repair neither
repeats that protected effect nor authorizes a new one. Exact-head hosted image,
required checks, governed deployment and authenticated deployed journey remain
required. No economic/comparative-gain/protected-admission claim is made.
