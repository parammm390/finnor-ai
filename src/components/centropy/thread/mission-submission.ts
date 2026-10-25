export interface MissionSpecification {
 packId:string
 input:Record<string,unknown>
 budgets?:{maxSteps?:number;maxActions?:number;maxQueries?:number;maxPlannerFailures?:number;maxConsecutiveNoProgress?:number;deadlineAt?:string}
}
export class MissionUnconfirmedError extends Error {
 readonly name='MissionUnconfirmedError'
}

function canonical(value:unknown):string {
 if(value===null||typeof value!=='object')return JSON.stringify(value)??'null'
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
 return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}'
}

/** An interrupted POST can have committed. Retain the exact serialized command
 * in memory until its identity is confirmed or definitively rejected. */
export class MissionSubmission {
 readonly instructionId:string
 readonly threadId:string|undefined
 readonly dealId:string
 private readonly specificationKey:string
 private readonly serializedBody:string
 private state:{kind:'prepared'}|{kind:'unconfirmed'}|{kind:'accepted';workId:string}={kind:'prepared'}
 constructor(specification:MissionSpecification,context:{dealId:string;threadId?:string;instructionId?:string;workId?:string}){
  this.instructionId=context.instructionId??crypto.randomUUID()
  this.threadId=context.threadId;this.dealId=context.dealId
  this.specificationKey=canonical(specification)
  this.serializedBody=JSON.stringify({...specification,channel:'console',threadId:this.threadId,workId:context.workId,
   instructionId:this.instructionId,idempotencyKey:this.instructionId,
   activeContext:{version:1,capturedAt:new Date().toISOString(),source:'console',selectedEntities:[{entityType:'pe_deal',entityId:this.dealId}],excludedEntities:[],surface:{id:'deals',spatialState:'canvas'},filters:[]}})
 }
 matches(specification:MissionSpecification,dealId:string){return this.dealId===dealId&&canonical(specification)===this.specificationKey}
 get isUnconfirmed(){return this.state.kind==='unconfirmed'}
 get acceptedWorkId(){return this.state.kind==='accepted'?this.state.workId:undefined}
 markUnconfirmed(){if(this.state.kind!=='accepted')this.state={kind:'unconfirmed'}}
 confirm(workId:string){if(!workId||this.state.kind==='accepted'&&this.state.workId!==workId)throw new Error('The mission acceptance does not match its original Work');this.state={kind:'accepted',workId}}
 get body():Record<string,unknown>{return JSON.parse(this.serializedBody) as Record<string,unknown>}
}
