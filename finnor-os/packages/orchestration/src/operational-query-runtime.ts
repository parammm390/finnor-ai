import { resolveTenantVertical } from "@finnor/db";
import {
  executePrivateEquityOperationalQuery,
  isPrivateEquityOperationalQuery,
} from "@finnor/private-equity";
import {
  executeOperationalQuery as executeCoreOperationalQuery,
  type OperationalQueryOptions,
} from "@finnor/read-models";
import {
  PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS,
  type CanonicalOperationalQueryRequest,
  type CanonicalOperationalQueryIntent,
  type OperationalQueryResultFor,
} from "@finnor/shared-types";

export const CORE_OPERATIONAL_QUERY_INTENTS = [
  "work_list", "agent_activity", "company_context", "party_lookup", "party_context", "team_roster",
] as const;

export const WATER_OPERATIONAL_QUERY_INTENTS = [
  "customer_lookup", "customer_cohort", "schedule_range", "money_summary", "inventory_status", "business_state", "party_availability",
] as const;

const CORE = new Set<string>(CORE_OPERATIONAL_QUERY_INTENTS);
const WATER = new Set<string>(WATER_OPERATIONAL_QUERY_INTENTS);
const PE = new Set<string>(PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS);

export function operationalQueryIntentsForVertical(verticalKey: string): CanonicalOperationalQueryIntent[] {
  return [
    ...CORE_OPERATIONAL_QUERY_INTENTS,
    ...(verticalKey === "private_equity" ? PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS : []),
    ...(verticalKey === "water" ? WATER_OPERATIONAL_QUERY_INTENTS : []),
  ];
}

/** One tenant-aware dispatcher for the existing Operational Query Plane. It
 * reveals no cross-vertical entity existence: an unavailable intent is rejected
 * before its package-specific reader runs. */
export async function executeTenantOperationalQuery<T extends CanonicalOperationalQueryRequest>(
  tenantId: string,
  request: T,
  options: OperationalQueryOptions = {},
): Promise<OperationalQueryResultFor<T>> {
  const vertical = await resolveTenantVertical(tenantId);
  const allowed = operationalQueryIntentsForVertical(vertical.verticalKey);
  if (!allowed.includes(request.intent)) throw new Error("Operational query intent is unavailable for this tenant vertical");
  if (PE.has(request.intent)) {
    if (!isPrivateEquityOperationalQuery(request)) throw new Error("Invalid private-equity query contract");
    return executePrivateEquityOperationalQuery(tenantId, request, options) as Promise<OperationalQueryResultFor<T>>;
  }
  if (!CORE.has(request.intent) && !WATER.has(request.intent)) throw new Error("Unsupported operational query intent");
  return executeCoreOperationalQuery(tenantId, request, options) as Promise<OperationalQueryResultFor<T>>;
}
