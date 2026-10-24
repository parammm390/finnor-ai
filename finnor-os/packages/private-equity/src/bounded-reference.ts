import {z} from 'zod';

/** Existing M1/M2 reference primitive, without either owner's runtime graph. */
export const BoundedReferenceSchema=z.object({
 owner:z.string().min(1).max(128),id:z.string().min(1).max(512),
 version:z.string().min(1).max(128),contentDigest:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
