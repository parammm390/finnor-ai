declare const certifiedProductionMutationCapability: unique symbol;

export interface ProductionMutationAuthorizationResult {
  readonly [certifiedProductionMutationCapability]: true;
  ok: true;
  operation: string;
  commitSha: string;
  runId: string;
  digest: string;
  oidcSubject: string;
}

export function authorizeProductionMutation(
  operation: string,
  options?: { authorizationPath?: string },
): Promise<ProductionMutationAuthorizationResult>;

export function assertProductionMutationCapability(
  capability: unknown,
  operation: string,
): asserts capability is ProductionMutationAuthorizationResult;
