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
  PRIVATE_EQUITY_VERTICAL,
  PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS,
  assertExecutableVertical,
  type CanonicalOperationalQueryRequest,
  type CanonicalOperationalQueryIntent,
  type OperationalQueryResultFor,
} from "@finnor/shared-types";

export const CORE_OPERATIONAL_QUERY_INTENTS = [
  "work_list", "agent_activity", "company_context", "party_lookup", "party_context", "team_roster",
] as const;

const CORE = new Set<string>(CORE_OPERATIONAL_QUERY_INTENTS);
const PE = new Set<string>(PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS);

export function operationalQueryIntentsForVertical(verticalKey: string): CanonicalOperationalQueryIntent[] {
  assertExecutableVertical(verticalKey);
  return [
    ...CORE_OPERATIONAL_QUERY_INTENTS,
    ...(verticalKey === PRIVATE_EQUITY_VERTICAL ? PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS : []),
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
  if (!CORE.has(request.intent)) throw new Error("Unsupported operational query intent");
  return executeCoreOperationalQuery(tenantId, request, options) as Promise<OperationalQueryResultFor<T>>;
}
