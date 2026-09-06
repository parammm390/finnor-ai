// Dealer Setup Readiness: scans a tenant's domain_policies rows and reports which
// action types are unconfigured, fully configured, or configured-but-gated-by-choice.
// This is the "what's left to tune for this dealer" answer — one query, not N+1.
//
// Deliberately does not import PluginRegistry (packages/orchestration, one layer up) —
// domain-plugins must not depend on orchestration. Callers pass a plain descriptor list.

import { withTenant, domainPolicies } from "@finnor/db";
import { and, eq } from "drizzle-orm";
import { findPlaceholderPaths } from "./plugin-interface";

export interface ActionTypeDescriptor {
  actionType: string;
  pluginName: string;
}

export type ActionReadinessStatus = "unconfigured" | "configured" | "gated_by_choice";

export interface ActionTypeReadiness extends ActionTypeDescriptor {
  status: ActionReadinessStatus;
  hasPolicyRow: boolean;
  requiresConfirmation: boolean;
  placeholderFields: string[];
}

export async function scanActionTypeReadiness(
  tenantId: string,
  descriptors: ActionTypeDescriptor[],
): Promise<ActionTypeReadiness[]> {
  const rows = await withTenant(tenantId, (db) => db.select().from(domainPolicies).where(and(
    eq(domainPolicies.tenantId, tenantId),
    eq(domainPolicies.active, true),
  )));
  const byActionType = new Map(rows.map((r) => [r.actionType, r]));
  return descriptors.map(({ actionType, pluginName }) => {
    const row = byActionType.get(actionType);
    const placeholderFields = row ? findPlaceholderPaths(row.policy) : [];
    const status: ActionReadinessStatus =
      !row || placeholderFields.length > 0 ? "unconfigured" : row.requiresConfirmation ? "gated_by_choice" : "configured";
    return {
      actionType,
      pluginName,
      status,
      hasPolicyRow: Boolean(row),
      requiresConfirmation: row?.requiresConfirmation ?? true,
      placeholderFields,
    };
  });
}
