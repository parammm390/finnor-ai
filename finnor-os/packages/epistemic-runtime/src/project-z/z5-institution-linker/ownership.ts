/** Shared fail-closed predicates. Native SQL supplies facts; these predicates
 * do not authenticate anybody or manufacture an owner/resource permission. */
const canonical = (value: unknown): string => value && typeof value === "object"
  ? Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]"
    : "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}"
  : JSON.stringify(value);
export interface BoundScope {
  tenant: string; principal: string; work: string; input: string; root: unknown;
  inputDigest: string; sourceDigest: string; rightsRevision: string; liveDigest: string; ownerCutDigest: string;
  profile: unknown; mandate: unknown; assignment: unknown; parentReservation: unknown;
  preparation: unknown; policy: unknown; allocation: unknown; consumption: unknown;
  unresolvedObligations: unknown; originalDeadline: string;
}
const fields = ["tenant", "principal", "work", "input", "root", "inputDigest", "sourceDigest", "rightsRevision",
  "liveDigest", "ownerCutDigest", "profile", "mandate", "assignment", "parentReservation", "preparation",
  "policy", "allocation", "consumption", "unresolvedObligations", "originalDeadline"].sort();
export function assertCurrentScope(original: BoundScope, actual: BoundScope) {
  if (Object.keys(original).sort().join(",") !== fields.join(",")
    || Object.keys(actual).sort().join(",") !== fields.join(",")
    || fields.some(k => original[k as keyof BoundScope] === undefined || actual[k as keyof BoundScope] === undefined)
    || canonical(original) !== canonical(actual) || !Number.isFinite(Date.parse(original.originalDeadline))
    || Date.parse(original.originalDeadline) <= Date.now()) throw Error("Z5_ORIGINAL_BOUND_SCOPE_NOT_CURRENT");
}
export interface PhysicalFence { tenant: string; token: string | null; fence: number; cancelled: boolean; status: string; deadline: number }
export function assertPhysicalFence(current: PhysicalFence, executing: { tenant: string | null; token: string; fence: number }) {
  if (!current.token || current.tenant !== executing.tenant || current.token !== executing.token
    || current.fence !== executing.fence || current.cancelled || current.status !== "RUNNING" || current.deadline <= Date.now())
    throw Error("Z5_STALE_OR_CANCELLED_PHYSICAL_FENCE");
}
