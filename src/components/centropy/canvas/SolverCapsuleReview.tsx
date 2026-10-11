"use client"
import {useCallback,useEffect,useRef,useState,type FormEvent} from "react"
import {usePathname,useRouter,useSearchParams} from "next/navigation"
import {z} from "zod"
import {centropyPost} from "@/components/centropy/lib/api"
import {useCentropyAuth} from "@/components/centropy/lib/centropy-auth"
import {onBusinessInvalidation} from "@/components/centropy/lib/business-invalidation"
import {CapitalRefViewSchema as reference} from "./capital-ref-view"

const reviewSchema=z.object({requestId:z.string().uuid(),workId:z.string().uuid(),workInputDigest:z.string(),status:z.string(),
 generation:z.number().int(),capsuleRef:reference.nullable(),semanticGate:z.string(),domainGate:z.string(),admissionGate:z.string(),
 activationGate:z.string(),economicGate:z.string(),originalGrant:z.object({deadline_at:z.string(),rounds_used:z.number(),max_rounds:z.number(),attempts_used:z.number()}),
 candidate:z.object({domainInputs:z.number(),subsetChecks:z.number(),trialCount:z.number(),counterexampleCount:z.number(),profile:z.string()}).nullable(),
 progress:z.object({checkedInputs:z.number(),trialCount:z.number(),counterexampleCount:z.number(),historicalDiagnosticRoute:z.string().nullable(),wholeDomainClaim:z.boolean()}),
 failure:z.string().nullable(),unsupportedReasons:z.array(z.string()),executionAuthorityGranted:z.literal(false)})
type Review=z.infer<typeof reviewSchema>
type Scoped<T>={scope:string;value:T}
/** Owner payloads remain exact opaque preimages; the server rebuilds every S4/S5
 * premise. Editing this form cannot supply receipts, expected answers or code. */
const contextSchema=z.object({workId:z.string().uuid(),workInputDigest:z.string(),executionAuthorityGranted:z.literal(false),
 policies:z.array(z.object({ref:reference,mandate:z.unknown(),bindings:z.unknown(),problem:z.unknown(),nodes:z.array(z.unknown()),
  rootNodeId:z.string(),resultState:z.string()})).max(16),
 resources:z.object({resources:z.array(z.object({ref:reference,resourceId:z.string(),unit:z.string()})).max(16)})})

export function SolverCapsuleReview({workId,root}:{workId:string;root:{entityType:string;entityId:string}}){
 const auth=useCentropyAuth(),router=useRouter(),pathname=usePathname(),search=useSearchParams()
 const token=useRef({value:auth.session?.access_token,version:0})
 if(token.current.value!==auth.session?.access_token)token.current={value:auth.session?.access_token,version:token.current.version+1}
 const allowed=!!auth.session&&auth.role==="owner"&&!auth.roleError&&!auth.roleLoading&&!auth.loading
 const requestId=search.get("solverRequest")
 // Fence during render, before effect cleanup or any delayed response. URL
 // request identity and current access are as private as the Work/root.
 const scope=JSON.stringify([auth.session?.user.id??"signed-out",token.current.version,workId,
  root.entityType,root.entityId,requestId,allowed])
 const epoch=useRef(0),currentScope=useRef(scope);currentScope.current=scope
 const [review,setReview]=useState<Scoped<Review>|null>(null),[draftState,setDraft]=useState<Scoped<string>|null>(null),
  [contextState,setContext]=useState<Scoped<z.infer<typeof contextSchema>>|null>(null),
  [busyState,setBusy]=useState<Scoped<boolean>|null>(null),[messageState,setMessage]=useState<Scoped<string>|null>(null),
  [selection,setSelection]=useState<{scope:string;route:string;candidate:string[];status:string}|null>(null)
 const current=allowed&&review?.scope===scope?review.value:null
 const draft=allowed&&draftState?.scope===scope?draftState.value:""
 const context=allowed&&contextState?.scope===scope?contextState.value:null
 const busy=allowed&&busyState?.scope===scope?busyState.value:false
 const message=allowed&&messageState?.scope===scope?messageState.value:""
 const notify=useCallback((value:string)=>setMessage({scope,value}),[scope])
 const working=useCallback((value:boolean)=>setBusy({scope,value}),[scope])
 const active=useCallback((n:number)=>allowed&&n===epoch.current&&currentScope.current===scope&&document.visibilityState==="visible",[allowed,scope])
 const clear=useCallback(()=>{setReview(null);setContext(null);setSelection(null);setDraft(null)},[])
 const refresh=useCallback(async(id:string,n:number)=>{
  try{const value=reviewSchema.parse(await centropyPost("company-brain/solver-read",{requestId:id}))
   if(!active(n))return
   if(value.workId!==workId||value.requestId!==id)throw Error("Work or method identity changed.")
   setReview({scope,value});if(value.status!=="COMPLETE")setSelection(null)
  }catch{if(active(n)){clear();notify("Current access or owner inputs could not be verified. Private values cleared.")}}
 },[scope,workId,clear,active,notify])
 useEffect(()=>{epoch.current++;clear();setBusy(null);setMessage(null)},[scope,clear])
 useEffect(()=>{
  if(!allowed)return
  let stopped=false,reading=false,timer:ReturnType<typeof setTimeout>|undefined
  const tick=async()=>{clearTimeout(timer);timer=undefined;if(stopped||reading||document.visibilityState!=="visible")return
   reading=true;try{if(requestId&&/^[a-f0-9-]{36}$/i.test(requestId))await refresh(requestId,epoch.current)}finally{reading=false}
   if(!stopped)timer=setTimeout(()=>void tick(),4000)}
  const invalidate=()=>{epoch.current++;clear();working(false);notify("Owner inputs changed. Recheck before reuse.")}
  const visible=()=>{invalidate();if(document.visibilityState==="visible")void tick()}
  const unsubscribe=onBusinessInvalidation(event=>{
   if(/company-brain\/solver-/.test(event.path??""))return
   if(event.tags.some(tag=>["work","company-brain","authority","source","underwriting"].includes(tag))){invalidate();void tick()}
  })
  void tick();window.addEventListener("pagehide",invalidate);document.addEventListener("visibilitychange",visible)
  const generation=epoch
  return()=>{stopped=true;generation.current++;clearTimeout(timer);unsubscribe();window.removeEventListener("pagehide",invalidate);document.removeEventListener("visibilitychange",visible)}
 },[allowed,requestId,scope,refresh,clear,working,notify])
 async function perform(run:(n:number)=>Promise<void>){
  if(!allowed||busy||document.visibilityState!=="visible")return
  const n=++epoch.current;working(true);setSelection(null)
  try{await run(n)}catch{if(active(n)){clear();notify("The owner refused this request or currentness could not be verified. No capital or execution authority was granted.")}}
  finally{if(active(n))working(false)}
 }
 function submit(event:FormEvent){event.preventDefault();void perform(async n=>{
  const input=JSON.parse(draft) as Record<string,unknown>
  const result=z.object({requestId:z.string().uuid(),workId:z.string().uuid(),status:z.string(),executionAuthorityGranted:z.literal(false)}).parse(
   await centropyPost("company-brain/solver-request",{...input,schema:"finnor.r8.synthesis-request.v1",workId,
    idempotencyKey:crypto.randomUUID(),limits:{deadlineMs:3600000,maxRounds:16}}))
  if(!active(n))return;if(result.workId!==workId)throw Error("Work identity changed.")
  const params=new URLSearchParams(search.toString());params.set("solverRequest",result.requestId)
  router.replace(`${pathname}?${params}`,{scroll:false});notify("Durable solver preparation queued. No verified or active claim exists yet.")
 })}
 return <section aria-label="Solver method for current Work" className="ct-capital-program">
  <h4>Verified solver method</h4>
  <p>Three independent integer projects, capacity seven. Supplied utility is not a forecast or owner wealth. Minimum canonical mask breaks ties.</p>
  <button type="button" disabled={!allowed||busy} onClick={()=>void perform(async n=>{
   const value=contextSchema.parse(await centropyPost("company-brain/solver-context",{workId,root}))
   if(active(n)){if(value.workId!==workId)throw Error("Work identity changed.");setContext({scope,value});notify("Current original policies and complete resources loaded.")}
  })}>Load current owner inputs</button>
  {context?<p>{context.policies.length} current original policies; resources {context.resources.resources.map(r=>`${r.resourceId} (${r.unit})`).join(", ")||"unavailable"}. Exactly three compatible policies and a lossless canonical joint model are required.</p>:null}
  <form onSubmit={submit}><label>Exact existing S4/S5 allocation input
   <textarea aria-describedby="solver-input-help" required disabled={!allowed} value={draft} maxLength={65536} rows={5}
    onChange={event=>{if(allowed)setDraft({scope,value:event.target.value})}} />
  </label><p id="solver-input-help">Paste the original mandate, three policy refs, full resource refs, supplied canonical joint model, demand bindings and funding. Do not supply costs, results, code or verification receipts separately. Unsupported or unbound data is refused.</p>
  <button type="submit" disabled={!allowed||busy||!draft}>Prepare solver for this Work</button></form>
  <p role="status" aria-live="polite">{message}</p>
  {current?<><p>{current.status.toLowerCase()}. {current.originalGrant.rounds_used}/{current.originalGrant.max_rounds} original rounds spent; {current.originalGrant.attempts_used} attempts. Deadline {current.originalGrant.deadline_at}.</p>
   {current.candidate?<p>{current.candidate.domainInputs.toLocaleString()} inputs and {current.candidate.subsetChecks.toLocaleString()} subset checks. {current.candidate.counterexampleCount} retained counterexamples across {current.candidate.trialCount} trials.</p>:<p>Provisional only. No complete-domain acceptance.</p>}
   {!current.candidate?<p>{current.progress.checkedInputs.toLocaleString()} independently checked inputs retained for the current candidate; {current.progress.counterexampleCount} counterexamples across {current.progress.trialCount} trials. Partial coverage cannot admit or activate a method.</p>:null}
   {current.progress.historicalDiagnosticRoute?<p>Retained historical diagnostic: {current.progress.historicalDiagnosticRoute}. This does not establish current admission or activation.</p>:null}
   <dl><dt>Semantics</dt><dd>{current.semanticGate}</dd><dt>Domain</dt><dd>{current.domainGate}</dd><dt>Admission</dt><dd>{current.admissionGate}</dd><dt>Activation</dt><dd>{current.activationGate}</dd><dt>Economics</dt><dd>{current.economicGate}, money, human effort and aggregate peak memory remain unmetered.</dd></dl>
   {current.failure?<p role="alert">{current.failure}</p>:null}
   <ul>{current.unsupportedReasons.map(reason=><li key={reason}>{reason}</li>)}</ul>
   <button type="button" disabled={busy} onClick={()=>void perform(n=>refresh(current.requestId,n))}>Recheck current method</button>
   <button type="button" disabled={busy||current.status!=="COMPLETE"} onClick={()=>void perform(async n=>{
    const value=z.object({requestId:z.string().uuid(),actualRoute:z.string(),status:z.string(),candidate:z.array(z.string()).nullable(),
     reservation:z.null(),executionAuthorityGranted:z.literal(false)}).parse(await centropyPost("company-brain/solver-selection",{requestId:current.requestId}))
    if(active(n)){if(value.requestId!==current.requestId)throw Error("Method identity changed.");setSelection({scope,route:value.actualRoute,status:value.status,candidate:value.candidate??[]})}
   })}>Check diagnostic reuse or original fallback</button>
   <button type="button" disabled={busy||!["QUEUED","RUNNING"].includes(current.status)} onClick={()=>void perform(async n=>{
    await centropyPost("company-brain/solver-cancel",{requestId:current.requestId});if(active(n))await refresh(current.requestId,n)
   })}>Cancel new solver work</button>
  </>:null}
  {allowed&&selection?.scope===scope?<p>Actual {selection.route}, {selection.status.toLowerCase()}, {selection.candidate.length} original policies selected. Independently checked diagnostic only, no capital reservation or effect.</p>:null}
 </section>
}
