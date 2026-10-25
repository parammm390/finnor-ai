# Z4 whole-shape choice, before product code

Both options implement the identical frozen signed32/checked-signed64 runtime
relation, input binding and original correspondence/checker/owner envelope.
Neither source paper nor library badge supplies project security admission.

| Shape | Actual source inspected | Setup and engineering consequences |
|---|---|---|
| Nova IVC with compressed Spartan, Pallas/Vesta Pedersen + IPA | Microsoft/Nova `01b1e2d662a847ed7029770ecbaf6687398899dd`, Cargo 0.76.0, Rust minimum 1.88; README, license, security policy, actual provider definitions, StepCircuit/RO traits and minroot/hashchain API examples | Transparent deterministically generated independent curve generators, no tau or ceremony. Per-runtime-function circuit. Fixed step state binds counter, input accumulator and registers. Compressed proof does not include a full execution trace. CPU-only. Proving/parameter cost is likely much larger than these small direct checks. |
| Full-trace STARK with Winterfell AIR/FRI | facebook/winterfell `2f78ee9bf667a561bdfcdfa68668d0f9b18b8315`, version 0.13.1, README/API and published research warning, Rust minimum 1.87, MIT | Transparent hash/FRI approach; requires a second complete AIR compiler with signed range, input binding, padding/length constraints and explicit reviewed FRI options. Logarithmic trace openings, larger proofs. No incremental checkpoint interface equivalent to Nova. README explicitly says unaudited/not production-ready. |

Choose Nova's native StepCircuit API with **PallasEngine/VestaEngine and
IPA on both curves**. Do not copy the examples' BN256 KZG configuration:
it requires powers of tau. Disable default/io/test-utils/experimental features.
No random-tau generation, downloaded SRS, trusted setup or security-level claim.
Actual code reports library challenge/hash constants as parameters, not an
invented end-to-end failure exponent. The CPU/toolchain, dependency lock and
MIT notices must be packaged. Binary identity includes native/compiler source.

Use independent original TypeScript bigint interpretation and a separately
executed native cryptographic verifier. Correspondence needs an inspectable
constraint contract, actual backend shape and independent semantic checks;
finite cases alone are not a universal compiler theorem. All input rows are
public under this profile. Input-commitment hashing is part of the proved
relation, not a hash-chain substituted for the computation proof.

Native integration is concrete adapter code to existing Work/jobs, S1,
shared S5 application reservation/charges, S3/S4 and independent audit.
Persist ordinary immutable phase artifacts; do not add a private resource or
effect ledger. Shared wiring, generated contracts and mounts are delivered as
exact preimage-bound coordinator requests. Missing application is integration
incompleteness, not a custody excuse.

Architecture engineering acceptance is distinct from mathematical/security
domain review. No production, secrecy, financial, 100x or value claim is made.
