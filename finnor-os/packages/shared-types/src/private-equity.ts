/** Canonical runtime root vocabulary for the Private Equity world graph. */
export const PE_WORLD_ROOT_TYPES = [
  "pe_strategy",
  "pe_opportunity",
  "pe_deal",
  "pe_fund",
  "pe_vehicle",
  "external_organization",
  "pe_portfolio_holding",
] as const;

export type PeWorldRootType = (typeof PE_WORLD_ROOT_TYPES)[number];

export interface PeWorldRootRef {
  entityType: PeWorldRootType;
  entityId: string;
}
