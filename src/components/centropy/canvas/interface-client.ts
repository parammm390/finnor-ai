import {z} from 'zod'
import {centropyPost as jarvisPost} from '@/components/centropy/lib/api'
const root=z.object({entityType:z.string(),entityId:z.string().uuid()}).strict()
const ref=z.object({owner:z.enum(['P5','S8']),id:z.string(),version:z.string(),contentDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
export const InterfaceOperationSchema=z.object({
 meaning:z.literal('set-record-field'),account:z.string(),entity:z.string(),field:z.string(),unit:z.literal('currency'),currency:z.string().regex(/^[A-Z]{3}$/),
 value:z.string().nullable(),tolerance:z.literal('0'),priorRevision:z.string(),operationId:z.string(),
}).strict()
export type InterfaceOperation=z.infer<typeof InterfaceOperationSchema>
const observation=z.object({account:z.string(),entity:z.string(),field:z.string(),unit:z.string(),currency:z.string(),value:z.unknown(),
 revision:z.string(),operationId:z.string().nullable(),observedAt:z.string(),rawDigest:z.string()}).strict()
const practice=z.object({status:z.enum(['VERIFIED','DISCREPANCY','UNKNOWN']),reason:z.string().nullable(),observation:observation.nullable()}).passthrough()
const moduleCodec=z.object({digest:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.string().max(8192),format:z.enum(['BOUNDED_HTTP_IR','BOUNDED_UI_IR']),entrypoint:z.enum(['bind','interact'])}).strict()
export const CurrentInterfaceSchema=z.object({
 schema:z.literal('finnor.p5.current-reader.v1'),acquisitionId:z.string().uuid(),workId:z.string().uuid(),root,requestedOperation:InterfaceOperationSchema,
 sourceVersion:z.string().nullable(),substrate:z.enum(['API','UI']),status:z.enum(['QUEUED','RUNNING','PROTOTYPE','PRACTICED','SUPPORTED_DISPOSABLE','UNKNOWN','DISCREPANCY','FAILED','CANCELLED','QUARANTINED']),
 reason:z.string().nullable(),capability:z.object({adapterModule:ref,observerModule:ref,schemaOrUiVersion:ref,postcondition:ref,retryAndUnknown:ref,
  generated:z.object({adapterModule:moduleCodec,observerModule:moduleCodec,interfaceVersion:z.string(),qualification:z.string()}).passthrough()}).passthrough().nullable(),
 practice:practice.nullable(),admission:ref.nullable(),protectedExecution:z.literal(false),liabilityReleased:z.literal(false),possibleEgress:z.boolean(),
 costs:z.object({learningAttempts:z.number().int().nonnegative(),wireAttempts:z.number().int().nonnegative(),recoveryReads:z.number().int().nonnegative(),usd:z.null(),status:z.literal('LOCAL_COST_UNMETERED')}).strict(),
}).passthrough()
export type CurrentInterface=z.infer<typeof CurrentInterfaceSchema>
const projection=z.object({schema:z.literal('finnor.p5.work-projection.v1'),workId:z.string().uuid(),acquisitions:z.array(CurrentInterfaceSchema).max(4),
 protectedExecution:z.literal(false)}).passthrough()
export async function readInterfaceProjection(expectedRoot:z.infer<typeof root>,workId:string){
 const data=projection.parse(await jarvisPost('company-brain/interface-projection',{root:expectedRoot,workId}))
 if(data.workId!==workId||data.acquisitions.some(r=>r.workId!==workId||r.root.entityId!==expectedRoot.entityId||r.root.entityType!==expectedRoot.entityType))throw Error('Interface belongs to another Work or source.')
 return data
}
export async function downloadInterfaceModule(id:string,kind:'ADAPTER'|'OBSERVER'){
 return z.object({module:moduleCodec,admission:ref.nullable(),protectedExecution:z.literal(false)}).strict().parse(await jarvisPost('company-brain/interface-module',{acquisitionId:id,kind}))
}
