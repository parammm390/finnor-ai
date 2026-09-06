/**
 * Core contract for runtime-composed business verticals.
 *
 * A vertical key is deliberately open: Core understands `none` and resolves a
 * tenant's configured key, while vertical packages own their names and entity
 * definitions.  Canonical entity references never carry tenant identity; the
 * authenticated database context remains the only tenant selector.
 */
export const NO_VERTICAL = "none" as const;
export const PRIVATE_EQUITY_VERTICAL = "private_equity" as const;
/** Historical identity only. It must never be accepted as executable runtime input. */
export const RETIRED_WATER_VERTICAL = "water" as const;

export const EXECUTABLE_VERTICALS = [NO_VERTICAL, PRIVATE_EQUITY_VERTICAL] as const;
export type ExecutableVerticalKey = (typeof EXECUTABLE_VERTICALS)[number];

export const RETIRED_VERTICAL_ERROR_CODE = "RETIRED_VERTICAL" as const;

/** Stable, non-sensitive refusal shared by API, worker, import, and source boundaries. */
export class RetiredVerticalError extends Error {
  readonly code = RETIRED_VERTICAL_ERROR_CODE;
  readonly verticalKey: string;

  constructor(verticalKey: string) {
    super(`The ${verticalKey} product vertical is retired and unavailable for execution.`);
    this.name = "RetiredVerticalError";
    this.verticalKey = verticalKey;
  }
}

export function isExecutableVertical(value: string): value is ExecutableVerticalKey {
  return (EXECUTABLE_VERTICALS as readonly string[]).includes(value);
}

export function assertExecutableVertical(value: string): asserts value is ExecutableVerticalKey {
  if (!isExecutableVertical(value)) throw new RetiredVerticalError(value);
}

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
