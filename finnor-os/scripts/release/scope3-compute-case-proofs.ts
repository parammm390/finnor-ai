/** Exact passing assertion identities required for each mandatory case. A green
 * suite alone cannot certify a case: missing, renamed, skipped, and TODO tests
 * are rejected by the certification runner. The Scope-2 markers come only from
 * its own full disposable-Postgres/real-SIGKILL certification result. */
const C = (name: string) => `Scope-3 executable contract ${name}`;
const P = (name: string) => `Scope-3 real PostgreSQL compute plane ${name}`;
const L = (name: string) => `Scope-3 disposable large-backlog load ${name}`;
const B = (name: string) => `compute backpressure acceptance boundary ${name}`;
const G = (name: string) => `B5 cost governor ${name}`;
const R = (name: string) => `distinct provider and model capacity contracts ${name}`;
const N = (name: string) => `node:${name}`;
const S1 = "scope1:certified";
const S2 = "scope2:certified";

const inventory = C("keeps the production handler inventory exhaustive and on one shared registry");
const classification = C("classifies from trusted type and lane only; payload-shaped promotion is inert");
const oneStore = C("retains one canonical jobs table and no class-specific queue tables");
const claimSql = C("filters class, protocol, due time, tenant fairness, and epoch inside the claim transaction");
const envelopes = C("defines four independent bounded task, slot, resource, role, and ingress envelopes");
const dbEnvelope = C("proves the static ECS database-session envelope and managed pool hard cap");
const scaleTruth = C("treats zero healthy capacity and active work as scale pressure, never zero");
const scalePolicy = C("uses bounded metric dimensions and freshness-safe scale-in alarms");
const scheduler = C("keeps scheduler and recovery leadership fenced and class-explicit");
const cutover = C("uses the staged cutover fence and exact release identity for all four services");
const fourClaims = P("claims each of four classes only with its corresponding class service");
const largeLoad = L("measures 100k mixed queued jobs while all classes progress and an aged peer beats a flood");
const provider = P("globally fences configured provider permits and recovers a crashed holder after expiry");
const model = P("reserves model capacity for foreground and enforces per-tenant limits");
const deferred = P("defers physical capacity contention without burning the logical attempt");
const dueAge = P("excludes future and incompatible jobs from canonical eligible backlog and age");
const signal = P("handles actual SIGTERM by finishing in-flight Work without claiming the next job");
const fleet = N("all four classes require one-to-one healthy ECS task and current durable release evidence");
const workflow = N("active release workflow uses the governed four-class AWS compute cutover");
const convergence = N("wrong digest, revision, or class capability blocks release convergence");

export const SCOPE3_CASE_PROOFS: Readonly<Record<number, readonly string[]>> = {
  1: [inventory, classification, P("persists trusted instance classification and rejects forged class or unknown type")],
  2: [classification, P("persists trusted instance classification and rejects forged class or unknown type")],
  3: [oneStore],
  4: [fourClaims, claimSql],
  5: [fourClaims, claimSql],
  6: [fourClaims, claimSql],
  7: [fourClaims, claimSql],
  8: [claimSql],
  9: [P("keeps 100 simultaneously contending class workers inside their claim boundary")],
  10: [P("preserves deterministic priority order inside one fresh tenant class")],
  11: [P("uses a durable fair cursor so a tenant flood cannot bury another tenant"), largeLoad],
  12: [P("keeps global jobs in an explicit fair bucket independent of tenant backlog")],
  13: [envelopes],
  14: [envelopes, P("enforces the local slot cap while concurrent handlers execute")],
  15: [dbEnvelope, P("bounds four physical task processes to four DB sessions and releases a crashed holder")],
  16: [P("bounds four physical task processes to four DB sessions and releases a crashed holder")],
  17: [provider],
  18: [P("isolates a saturated provider from another configured provider"), R("permits a configured Graph operation without an unrelated model:global policy")],
  19: [model, R("fails closed when a model invocation lacks the mandatory model:global policy")],
  20: [model],
  21: [model],
  22: [G("persists provider-reported tokens and configured cost"), G("defers a non-urgent call at a forced hard cap without calling the provider"), G("treats completed calls with unknown token usage as unknown, never as zero")],
  23: [deferred],
  24: [deferred],
  25: [dueAge],
  26: [dueAge],
  27: [scaleTruth, largeLoad],
  28: [scaleTruth, largeLoad],
  29: [dueAge],
  30: [scaleTruth, scalePolicy],
  31: [envelopes, N("the Phase 8 production contract adds four independently required compute services without dropping either PE supplier canary")],
  32: [envelopes],
  33: [envelopes],
  34: [envelopes, largeLoad],
  35: [envelopes],
  36: [scheduler, P("writes truthful per-class heartbeat roles and removes them on drain")],
  37: [cutover, P("writes truthful per-class heartbeat roles and removes them on drain")],
  38: [scheduler, P("elects one fenced scheduler owner and transfers only after expiry")],
  39: [P("writes truthful per-class heartbeat roles and removes them on drain")],
  40: [fleet, N("a heartbeat from another task cannot stand in for a missing class task")],
  41: [signal],
  42: [signal],
  43: [P("rolls back a claim when shutdown arrives during the cutover lock wait"), P("returns a committed but undispatched claim when draining wins the dispatch race")],
  44: [S2, signal],
  45: [S2, P("bounds four physical task processes to four DB sessions and releases a crashed holder")],
  46: [S2],
  47: [largeLoad],
  48: [fourClaims, largeLoad],
  49: [largeLoad, model],
  50: [dbEnvelope, P("bounds four physical task processes to four DB sessions and releases a crashed holder"),
    P("fails saturated DB pool waits within a bounded deadline without opening extra sessions")],
  51: [deferred, provider],
  52: [model, deferred],
  53: [B("reports missing telemetry as degraded rather than fabricating zero demand"), dueAge],
  54: [B("preserves required Work after durable acceptance under identical saturation")],
  55: [envelopes, scalePolicy],
  56: [scalePolicy],
  57: [scalePolicy],
  58: [envelopes],
  59: [scalePolicy],
  60: [cutover, workflow],
  61: [fleet, convergence],
  62: [convergence, N("legacy infrastructure is removed only after a separate routing stage")],
  63: [workflow, N("canonical release and AWS target guards fail closed")],
  64: [workflow, N("normal rollouts may change only all four class task definitions and services")],
  65: [S1],
  66: [S2],
  67: [S1, S2],
  68: [S1, S2],
  69: [S1, S2],
  70: [S1, S2],
  71: [S1, S2],
  72: [S1, S2],
  73: [S1, S2],
  74: [C("keeps class profiles portable across the deferred Scope-14 network and Region migration")],
  75: [C("keeps Scope-3 ownership on existing jobs and ECS without introducing a future queue or orchestrator")],
};
