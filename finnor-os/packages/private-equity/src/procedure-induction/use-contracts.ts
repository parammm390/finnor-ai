/** Small shared-request proposal codec, independent of the P1/P6 AST cycle. */
import { z } from 'zod';
import { EvidenceRequestSchema } from '@finnor/shared-types';
export const ProcedureUseSchema = z.object({
  capsuleId: z.string().uuid(), mode: EvidenceRequestSchema.shape.mode,
}).strict();
export type ProcedureUse = z.infer<typeof ProcedureUseSchema>;
