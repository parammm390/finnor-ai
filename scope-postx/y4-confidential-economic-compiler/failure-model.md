# Y4 failure model, recorded before compiler/checker/oracle implementation

## Numerical and translation boundary

Wrong native IR/version; producer-normalized assertions replacing the original
function; unsupported operators accepted; secret-dependent branch or memory
leak; eager evaluation of a lazy invalid branch; reordered decimal folds;
lost units, currency, time, ownership, provenance or rounding; division by zero;
signed comparison/tie error; wrong scaling; fixed-point truncation mistaken for
native decimal semantics; modular wrap; invalid input ranges; malicious range
assertion accepted as proof; a sampled equality called a universal translation
proof; emitted source differing from checked source/bytecode; checker substitution;
backend/compiler/lock changes after freezing; per-case hidden-function patches.

Acceptance: check the original canonical native function, complete declared
domain and actual emitted representation. Unsupported semantics fail closed.
All-input claims require a stated sound correspondence argument and checked
premises. Independent reference evaluation lives only in an authorized oracle,
never in the scored coordinator/compiler. No invalid result is called financial
INFEASIBLE. CHECKED never grants protected admission or effects.

## Confidential computation and participant custody

Semi-honest or honest-majority protocol substituted for malicious n−1-with-abort;
insecure build flags; fake/offline fixture preprocessing; omitted MAC/OT checks;
network identity substitution; insecure channels; source/binary substitution;
one-time randomness/preprocessing replay; failed MAC key reuse; truncated
transcripts; inconsistent shares; malicious input binding; private inputs,
salts, keys, preprocessing or private output in arguments, logs, receipts or UI;
coordinator reading participant input files; same-host isolation called
separately administered institutional security; fair output delivery inferred
from security with abort.

Acceptance: actual established protocol source and runtime flags, pinned native
binary/dependencies, authenticated participant-local input and exact session
bindings, actual adverse protocol tests and no unapproved reveal instructions.
No completion, fairness or protection from a common host administrator is
inferred. Production security review remains separately required.

## Rights, truth, currentness and cumulative disclosure

Foreign participant grants inherited; stale source/mandate/Work rights;
changed commitment attached to a fresh grant without revalidation; source
truth inferred from a signature; low-entropy exposed hashes used as hiding;
adaptive query differencing; per-query authorization bypasses shared cumulative
policy; concurrent release race; recipient change; output before final
authentication/currentness; revocation during checking/execution/release/use;
derivative still usable after authority removal; prior disclosure history
deleted or knowledge supposedly recalled.

Acceptance: recheck canonical current owner revisions at submission, acceptance,
execution, release and downstream use; atomic cumulative release reservation;
record releases and derivatives without protected values; suspend the smallest
sound affected closure; preserve prior disclosure and responsibility.

## Durable execution, ownership and recovery

Sidecar imitation of canonical owners; registration-only worker; mocked backend;
fixture receipt mistaken for independent execution; job replay/duplicate claim;
original budget/deadline renewed; partial participant start; process leaks;
lost cancellation; stale worker publishes after lease; unsafe resume/replay;
plaintext fallback; reservation released on protocol abort; unrelated dispatched
effect marked rolled back; UNKNOWN erased; costs/exposures lost on failures;
old principal response resurrects a private result; reconstruction borrows donor
objects, dependencies, build directories or secure assets.

Acceptance: actual API→queue→worker→compiler→checker→secure execution→release
→canonical consumer→Work path; fenced original leases/deadlines; safe fresh
cryptographic session on retry; original effect/reservation/obligation identities
retained; compatible admitted fallback only; durable readback; actual mounted
identity changes and independent lockfile-installed reconstruction.

## Test and evidence independence

Each verification case must name its observable contract, credible regression,
owning boundary, independent oracle, stronger missing coverage and retained
artifact. Negatives must reach their intended boundary. Do not accept fixture
flags, matching self-digests, exit zero or two calls to the same implementation
as independent proof. Keep original failed attempts and NOT_RUN cases.

## Source-owner bridge remediation, before its implementation

The API integration review found two additional concrete failure paths. Publishing
an original source byte hash or a digest of a low-entropy source scope can expose
an input by guessing. A coordinator must also not acquire another participant's
source-owner role merely to check whether that participant's consent is current.

Use participant-issued opaque source handles. Keep the complete source/mandate/
subject snapshot private to its existing owner. A verification-only owner helper
may compare that private snapshot with current canonical rows for an exact
consented computation. It must return only a boolean, reject outsiders and foreign
tenants, and never change the caller's identity or issue a source grant. A handle
is neither source truth nor permission to read bytes. Changed handles must not
reset the stable institution/source disclosure budget.

E1/F1 must exercise the real issuer and verifier, cross-principal and cross-tenant
denials, changed/revoked/superseded owner rows, absence of original byte hashes in
public metadata, and stable-source accounting across handles. Missing observations
remain NOT_RUN. This adds coverage; it does not remove any frozen case or gate.
