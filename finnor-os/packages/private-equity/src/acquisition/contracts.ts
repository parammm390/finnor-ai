import { z } from 'zod';
import {HarnessRequestSchema} from '../program-synthesis/contracts';
const nodeId = z.string().regex(/^[a-z][a-z0-9_.:-]{0,199}$/);
const amount = z.string().regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/).max(96);
export const AcquisitionAnalysisSchema=HarnessRequestSchema.pick({instruction:true,validAt:true,knowledgeAt:true,sources:true,acceptance:true,limits:true,procedure:true,ownerBindings:true,computeSearch:true}).extend({
    bindings:z.record(z.string(), z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)).refine(v=>Object.keys(v).length>0&&Object.keys(v).length<=16),
}).strict().superRefine((a,c)=>{
    if(a.computeSearch&&(!a.ownerBindings?.policyRef||!a.ownerBindings.allocationRef))c.addIssue({code:'custom',path:['ownerBindings'],message:'Required search needs its original policy and compute allocation'});
    if(a.computeSearch&&a.procedure)c.addIssue({code:'custom',path:['procedure'],message:'Procedure execution and allocated search require separate qualified recipes'});
});
const AcquisitionFieldsSchema = z.object({
    dealId: z.string().uuid(), workId: z.string().uuid(), baseRunId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(160),
    bidDomain: z.object({ nodeId, currency: z.string().regex(/^[A-Z]{3}$/), values: z.array(amount).min(1).max(64) }).strict(),
    financingCases: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), name: z.string().min(1).max(200),
        overrides: z.array(z.object({ nodeId, value: amount, reason: z.string().min(1).max(1000) }).strict()).max(32) }).strict()).min(1).max(16),
    constraints: z.array(z.object({ outputNodeId: nodeId, operator: z.enum(['gte', 'lte']), threshold: amount,
        unit: z.enum(['money', 'rate', 'multiple', 'ratio', 'count']), currency: z.string().regex(/^[A-Z]{3}$/).optional() }).strict()).min(1).max(16),
    analysis:AcquisitionAnalysisSchema.optional(),
    limits: z.object({ maxCandidates: z.number().int().min(1).max(256).default(256), deadlineMs: z.number().int().min(1000).max(300000).default(120000) }).strict().default({maxCandidates:256,deadlineMs:120000}),
}).strict();
const AcquisitionDomainFieldsSchema=AcquisitionFieldsSchema.omit({dealId:true,workId:true,baseRunId:true,idempotencyKey:true});
function validateAcquisitionDomain(r:z.output<typeof AcquisitionDomainFieldsSchema>,c:z.RefinementCtx){
    if(Buffer.byteLength(JSON.stringify(r))>131072)c.addIssue({code:'custom',message:'Acquisition request exceeds the bounded owner payload'});
    if (r.bidDomain.values.length * r.financingCases.length > r.limits.maxCandidates)
        c.addIssue({ code: 'custom', message: 'Declared bid and financing domain exceeds original candidate budget' });
    if (new Set(r.bidDomain.values).size !== r.bidDomain.values.length)
        c.addIssue({ code: 'custom', message: 'Bid domain must contain distinct amounts' });
    if (new Set(r.financingCases.map(f => f.key)).size !== r.financingCases.length)
        c.addIssue({ code: 'custom', message: 'Financing case keys must be unique' });
    for (const f of r.financingCases)
        if (new Set(f.overrides.map(o => o.nodeId)).size !== f.overrides.length || f.overrides.some(o => o.nodeId === r.bidDomain.nodeId))
            c.addIssue({ code: 'custom', message: 'Financing overrides must be unique and cannot replace the bid' });
}
export const AcquisitionRequestSchema=AcquisitionFieldsSchema.superRefine(validateAcquisitionDomain);
export const AcquisitionDomainSchema=AcquisitionDomainFieldsSchema.superRefine(validateAcquisitionDomain);
export type AcquisitionRequest = z.infer<typeof AcquisitionRequestSchema>;
export type {AcquisitionCandidate,AcquisitionResult} from '@finnor/shared-types';
export const AcquisitionActionSchema = AcquisitionFieldsSchema.omit({ workId: true, idempotencyKey: true }).superRefine(validateAcquisitionDomain);
