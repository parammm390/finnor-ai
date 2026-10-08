/** Small shared-request proposal codec, independent of the P1/P6 AST cycle. */
import { z } from 'zod';
export const ProcedureUseSchema = z.object({
  capsuleId: z.string().uuid(), mode: z.enum(['ordinary_disposable', 'protected']),
}).strict();
export type ProcedureUse = z.infer<typeof ProcedureUseSchema>;
