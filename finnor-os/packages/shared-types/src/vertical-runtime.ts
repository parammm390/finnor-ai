/**
 * Core contract for runtime-composed business verticals.
 *
 * A vertical key is deliberately open: Core understands `none` and resolves a
 * tenant's configured key, while vertical packages own their names and entity
 * definitions.  Canonical entity references never carry tenant identity; the
 * authenticated database context remains the only tenant selector.
 */
export const NO_VERTICAL = "none" as const;

export type TenantVerticalKey = typeof NO_VERTICAL | (string & {});

export interface TenantVerticalIdentity {
  tenantId: string;
  verticalKey: TenantVerticalKey;
  version: number;
  effectiveFrom: string;
  sourceSystem: string;
  sourceRef: string | null;
}

export interface CanonicalTruthRegistration<TType extends string = string> {
  entityType: TType;
  verticalKey: string | null;
  sourceSchema: "finnor_os";
  sourceTable: string;
  writableOwner: string;
  mutationBoundary: string;
  workAttachable: boolean;
}

export interface VerticalDefinition<TType extends string = string> {
  key: string;
  displayName: string;
  implementationOwner: string;
  entityTypes: readonly TType[];
}
