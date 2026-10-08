/** P6 outputs may feed the existing exact P1→P5 dependency. This reader
 * never sends the bound request or discharges UNKNOWN effect responsibility. */
import type { PeMutationContext } from '../types';
import { z } from 'zod';
import { loadProgrammeInterfaceModule } from '../program-synthesis/interface';
import { readCurrentProgram } from '../program-synthesis/store';
import { acquisition } from '../interface-synthesis/store';
import { authorize, sha } from '../evidence-execution/store';
import { currentCapsule } from './store';
import { boundedJson } from './contracts';

export const ProcedureInterfaceSchema = z.object({
  capsuleId: z.string().uuid(), programId: z.string().uuid(), acquisitionId: z.string().uuid(),
  outputKey: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
}).strict();
export async function loadProcedureInterface(ctx: PeMutationContext, input: unknown) {
  boundedJson(input, 4096);
  const request = ProcedureInterfaceSchema.parse(input);
  const acquired = await acquisition(ctx, request.acquisitionId);
  await authorize(ctx, acquired.request.root, [{ type: 'work', id: acquired.work_id }]);
  // UNKNOWN and other unpracticed paths cannot become a dependency. Refuse
  // before resolving expensive positive lineage; the owner still validates
  // every binding and currentness condition on the successful path below.
  if (!['PRACTICED', 'SUPPORTED_DISPOSABLE'].includes(acquired.status))
    throw Error('P5_CURRENT_PRACTICED_INTERFACE_REQUIRED');
  const capsule = await currentCapsule(ctx, request.capsuleId);
  const program = await readCurrentProgram(ctx, request.programId);
  const binding = program.program?.semanticBindings.find((v: any) =>
    v.producer === 'P6' && v.capsuleId === capsule.id && v.capsuleDigest === sha(capsule));
  if (program.status !== 'TESTED' || !binding) throw Error('P6_CURRENT_TRANSFERRED_PROGRAMME_REQUIRED');
  const module = await loadProgrammeInterfaceModule(ctx, {
    schema: 'finnor.p1.interface-module-request.v1', programId: request.programId,
    acquisitionId: request.acquisitionId, outputKey: request.outputKey,
  });
  await currentCapsule(ctx, capsule.id);
  return { capsuleRef: { owner: 'P6', id: capsule.id, version: capsule.producer.version,
    contentDigest: sha(capsule) }, interfaceModule: module,
    effectAuthority: false, responsibilityDischarged: false, protectedEligible: false };
}
