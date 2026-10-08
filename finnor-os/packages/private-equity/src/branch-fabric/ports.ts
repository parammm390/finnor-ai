import type { TenantContext } from '@finnor/shared-types';
import { fault, hash, type Prepare, type InputArtifact } from './contracts';
/** P3-local acquisition cut, not a replacement canonical producer envelope. */
export interface ProducerCut { payload: Record<string, any>; ownerBindings: Record<string, any> }
export interface PinnedProducerPort {
  owner: 'P4' | 'M1'; schema: 'finnor.evidence-derivation.v1' | 'finnor.decision-slice.v1'; buildDigest: string;
  readCurrent(ctx: TenantContext, request: Prepare): Promise<ProducerCut>;
}
const schemas = { P4: 'finnor.evidence-derivation.v1', M1: 'finnor.decision-slice.v1' } as const;
const ports = new Map<PinnedProducerPort['owner'], PinnedProducerPort>();
let initialized: Promise<void> | undefined;
function initialize() {
  return initialized ??= (async () => {
    const { initializeAuthenticProducerPorts } = await import('./producer-adapters');
    for (const port of await initializeAuthenticProducerPorts()) registerProducerPort(port);
  })();
}
/** Trusted fixed join bootstrap only. HTTP callers cannot register or replace ports. */
export function registerProducerPort(port: PinnedProducerPort) {
  if (port.schema !== schemas[port.owner] || !/^[a-f0-9]{64}$/.test(port.buildDigest)) fault('PRODUCER_PORT_INCOMPATIBLE');
  if (ports.has(port.owner)) fault('PRODUCER_PORT_ALREADY_PINNED');
  ports.set(port.owner, Object.freeze(port));
}
function registered(kind: string) {
  const owner = kind === 'p4' ? 'P4' : kind === 'm1' ? 'M1' : null;
  if (!owner) fault('PENDING_DEPENDENCY', 424);
  return { owner, port: ports.get(owner) ?? fault('PENDING_DEPENDENCY', 424) };
}
async function readPort(port: PinnedProducerPort, ctx: TenantContext, request: Prepare) {
  try { return await port.readCurrent(ctx, request); }
  catch (error) {
    // Dynamic TS/ESM owner loading can use a distinct constructor identity.
    // Normalize only this trusted adapter's finite P3 error contract, not worker
    // stdout or a caller-supplied error/authority object.
    const e = error as { code?: unknown; status?: unknown };
    if (error instanceof Error && error.constructor.name === 'BranchFault' &&
      typeof e.code === 'string' && /^[A-Z][A-Z0-9_]{0,128}$/.test(e.code) &&
      typeof e.status === 'number' && [400, 403, 404, 409, 413, 424, 503].includes(e.status)) fault(e.code, e.status);
    throw error;
  }
}
export async function acquireProducerSource(ctx: TenantContext, request: Prepare): Promise<ProducerCut> {
  await initialize();
  const { owner, port } = registered(request.source.kind), cut = await readPort(port, ctx, request);
  return { payload: cut.payload, ownerBindings: { ...cut.ownerBindings,
    producerOwner: owner, producerSchema: port.schema, producerBuildDigest: port.buildDigest,
    producerCutDigest: hash(cut), upstreamChargesDuplicated: false } };
}
export async function currentProducerSource(ctx: TenantContext, input: InputArtifact) {
  await initialize();
  const { port } = registered(input.source.kind);
  if (port.buildDigest !== input.ownerBindings.producerBuildDigest) fault('PRODUCER_BUILD_CHANGED');
  const cut = await readPort(port, ctx, { workId: input.basis.workId, root: input.root, kind: input.kind, profile: input.profile, source: input.source });
  if (hash(cut) !== input.ownerBindings.producerCutDigest) fault('PRODUCER_CURRENT_CUT_CHANGED');
}
