"use client"
import {z} from 'zod'
import {centropyPost} from '@/components/centropy/lib/api'
const ref=z.object({owner:z.string(),id:z.string(),revision:z.string(),contentDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
const field=z.object({id:z.string(),title:z.string(),type:z.enum(['text','boolean','enum','quantity','quantity-list','evidence','reference','relation']),
 required:z.boolean(),allowUnknown:z.boolean(),encoding:z.enum(['text','boolean','json']),options:z.array(z.string()).optional(),maxLength:z.number().optional()}).passthrough()
const action=z.object({id:z.string(),title:z.string(),kind:z.enum(['create','update','transition']),inputFields:z.array(z.string()),fromStates:z.array(z.string()),toState:z.string(),roles:z.array(z.string())}).strict()
export const ApplicationRecordSchema=z.object({id:z.string().uuid(),entityId:z.string(),state:z.string(),values:z.record(z.unknown()),reference:ref,revision:z.number().int().positive(),
 releaseId:z.string().uuid(),originReleaseId:z.string().uuid(),schemaReleaseId:z.string().uuid(),authorPrincipalId:z.string().uuid(),
 currentness:z.enum(['CURRENT','STALE']),releaseCurrent:z.boolean(),approvals:z.array(z.unknown()),preparedIntent:z.unknown().nullable(),pendingEffectId:z.string().uuid().nullable()}).strict()
const frontend=z.object({schema:z.literal('finnor.enterprise-application.forms.v1'),renderer:z.literal('FINNOR_HOST_TYPED_FORMS_V1'),
 entities:z.array(z.object({entityId:z.string(),title:z.string(),states:z.array(z.string()),initialState:z.string(),fields:z.array(field),actions:z.array(action),assetPath:z.string()}).strict())}).strict()
const view=z.object({applicationId:z.string().uuid(),status:z.string(),headReleaseId:z.string().uuid().nullable(),workId:z.string().uuid(),root:z.object({entityType:z.string(),entityId:z.string().uuid()}).strict(),
 frontend:frontend.nullable(),package:z.object({frontend:z.object({digest:z.string()}).passthrough()}).passthrough().nullable(),specification:z.unknown().nullable(),records:z.array(ApplicationRecordSchema),
 nextCursor:z.string().uuid().nullable(),builds:z.array(z.object({id:z.string(),generation:z.number(),change_class:z.string(),status:z.string(),failure:z.unknown().nullable()}).passthrough()),
 releases:z.array(z.object({id:z.string(),build_id:z.string(),maintenance:z.unknown()}).strict()),
 counters:z.object({builds:z.number(),mutations:z.number(),dataBytes:z.number(),releases:z.number(),deadlineAt:z.string()}).strict(),
 controls:z.object({canManage:z.boolean()}).strict(),protectedAdmission:z.literal(false)}).passthrough()
export type ApplicationView=z.infer<typeof view>
export type ApplicationRecord=z.infer<typeof ApplicationRecordSchema>
export type ApplicationEntity=z.infer<typeof frontend>['entities'][number]
export type ApplicationAction=ApplicationEntity['actions'][number]
const APPLICATION_POST_OPERATIONS=['submit','maintain','command','read','record','list','history','asset','cancel','rollback','impact','upload','prepare-effect','s8-propose','admission'] as const
export async function applicationPost<T>(operation:string,body:unknown){
 const registered=APPLICATION_POST_OPERATIONS.find(value=>value===operation)
 if(!registered)throw new Error('APPLICATION_INVALID_OPERATION')
 return centropyPost<T>('company-brain/application-'+registered,body)
}
function canonical(v:unknown):string{
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']'
 if(v!==null&&typeof v==='object')return '{'+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}'
 return JSON.stringify(v)
}
async function digest(s:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('')}
export async function readApplication(applicationId:string,cursor?:string){
 const parsed=view.parse(await applicationPost('read',{applicationId,limit:20,...(cursor?{cursor}:{})}))
 if(parsed.frontend&&(!parsed.package||await digest(canonical(parsed.frontend))!==parsed.package.frontend.digest))throw new Error('APPLICATION_FORM_INTEGRITY')
 return parsed
}
/** Chunked uploads preserve the 128 KiB request and 256 KiB contract bounds. */
export async function applicationSpecificationInput(specification:unknown,root:{entityType:string;entityId:string},stillCurrent:()=>boolean,uploadForDigest:(digest:string)=>string){
 const text=JSON.stringify(specification),bytes=new TextEncoder().encode(text)
 if(bytes.length>256*1024)throw new Error('Business contract exceeds 256 KiB')
 if(bytes.length<80*1024)return {specification}
 const chunks:string[]=[];let part='',size=0
 for(const character of text){const length=new TextEncoder().encode(character).length;if(size+length>32768){chunks.push(part);part='';size=0}part+=character;size+=length}
 if(part)chunks.push(part)
 // Escaped JSON can be larger than UTF-8. Conservative chunks still cannot
 // exceed 128 KiB. Eight 48 KiB fragments are the server's finite profile.
 if(chunks.length>8)throw new Error('This escaped contract exceeds the eight-fragment transport profile')
 const hash=await digest(text)
 if(!stillCurrent())throw new Error('Application identity changed during upload')
 const uploadId=uploadForDigest(hash)
 for(let i=0;i<chunks.length;i++){
  if(!stillCurrent())throw new Error('Application identity changed during upload')
  await applicationPost('upload',{root,uploadId,part:i,totalParts:chunks.length,digest:hash,bytes:chunks[i]})
 }
 return {specificationUploadId:uploadId}
}
