import {randomUUID,createHash} from "node:crypto";
import {resolve,basename} from "node:path";
import {realpath} from "node:fs/promises";
import type {ExperimentRef} from "@finnor/shared-types";
import type {CoalitionP1Module,CoalitionSelection} from "../../../shared-types/src/coalition-programme";
import type {PeMutationContext} from "../types";
import type {R2NativeSession} from "../capital-program/r2-native";
import {packagedCoalitionProgramme} from "../capital-program/r5-search";
import {m3Ref,m3Hash,m3Same,CapitalProgramV2Error} from "../capital-program/v2-contracts";
import {readM3Record,writeM3Record,m3Event,m3Tx,m3Query} from "../capital-program/v2-store";
import {readEnterpriseCoalitionSelection} from "../enterprise-control";
import {clearEnterpriseCoalitionAllocation,consumeEnterpriseCoalitionAllocation,assertCoalitionPlanningProfile} from "../capital-program/r5-allocation-owner";
import {prepareEnterpriseCoalitionSchedule} from "../capital-program/r5-obligations";
import {codeIdentity} from "../evidence-execution/store";
import {inM3Episode} from "../capital-program/v2-budget";
import {readR2Artifact,coalitionCheckerIdentity,r2Ref} from "../capital-program/r2-native";

interface ProgrammeRecord {
 schema:"finnor.p1.coalition-programme-record.v1";module:CoalitionP1Module;queryId:string;
 originalDeadlineAt:string;codeDigest:string;remainingCpuMs:number;
 compiler:Awaited<ReturnType<R2NativeSession["executeProgramme"]>>;
 checked:Awaited<ReturnType<R2NativeSession["checkCoalition"]>>;
}
export async function compileCoalitionOwnerProgramme(ctx:PeMutationContext,selection:CoalitionSelection,session:R2NativeSession,
 queryId:string,originalDeadlineAt:string,codeDigest:string,attemptId:string):Promise<ExperimentRef>{
 const packaged=await packagedCoalitionProgramme();
 const compiler=await session.executeProgramme(packaged.javascript,[{original:selection.original,candidate:selection.candidate,
  selectionRef:selection.ref,deadlineAt:session.deadlineAt}],1048576);
 const module=compiler.outputs as CoalitionP1Module;
 const checked=await session.checkCoalition(selection.original,"programme",
  {candidate:selection.candidate,selectionRef:selection.ref,module});
 if(checked.result.programmeQualified!==true||checked.result.programmeDigest!==m3Hash(module))
  throw new CapitalProgramV2Error("CHECK_FAILED","Independent selected P1 original programme preimage differs");
 const body:ProgrammeRecord={schema:"finnor.p1.coalition-programme-record.v1",module,queryId,originalDeadlineAt,codeDigest,
  remainingCpuMs:Math.max(0,session.caps.cpuMs-session.chargedCpuMs),compiler,checked};
 const ref=m3Ref("coalition-p1-programme",body);
 await writeM3Record(ctx,"modules",ref,body);
 await m3Event(ctx,queryId,attemptId,"CHECK",{phase:"P1_SELECTED_PROGRAMME_PUBLISHED",moduleRef:ref,
  originalDigest:module.originalDigest,candidateDigest:module.candidateDigest,
  independentPhysicalRef:checked.physicalRef,executionAuthorityGranted:false});
 return ref;
}
export async function readCoalitionOwnerProgramme(ctx:PeMutationContext,value:ExperimentRef){
 const publication=await m3Tx(ctx,async c=>(await c.query(
  "SELECT query_id FROM finnor_os.m3_events WHERE tenant_id=$1 AND principal_id=$2 AND kind='CHECK' AND body->>'phase'='P1_SELECTED_PROGRAMME_PUBLISHED' AND body->'moduleRef'->>'contentDigest'=$3 LIMIT 2",
  [ctx.auth.tenantId,ctx.auth.userId,value.contentDigest])).rows,true);
 if(publication.length!==1)throw new CapitalProgramV2Error("UNAVAILABLE","Permitted selected P1 programme is unavailable");
 const issued=await readM3Record<ProgrammeRecord>(ctx,"modules",value);
 if(issued.body.queryId!==publication[0].query_id||issued.body.schema!=="finnor.p1.coalition-programme-record.v1"||!m3Same(value,m3Ref("coalition-p1-programme",issued.body))||
  issued.body.checked.result.programmeQualified!==true||issued.body.checked.result.programmeDigest!==m3Hash(issued.body.module))
  throw new CapitalProgramV2Error("CHECK_FAILED","Actual selected P1 immutable module/checker binding differs");
 const selection=await readEnterpriseCoalitionSelection(ctx,issued.body.module.selectionRef);
 const query=await m3Query(ctx,issued.body.queryId);
 if(query.deadline_at?.toISOString()!==issued.body.originalDeadlineAt||query.acceptance.code.digest!==issued.body.codeDigest||
  !m3Same(query.acceptance.r5?.original,selection.original)||!Number.isFinite(issued.body.remainingCpuMs)||
  issued.body.remainingCpuMs<0||issued.body.remainingCpuMs>selection.original.limits.native.cpuMs)
  throw new CapitalProgramV2Error("CHECK_FAILED","Actual original P1 query/grant binding differs");
 const checked=issued.body.checked;
 const prefix=resolve(process.env.FINNOR_M3_STORE??"",ctx.auth.tenantId,ctx.auth.userId,"r2-native",issued.body.queryId)+"/";
 if(resolve(checked.stdoutPath)!==checked.stdoutPath||!checked.stdoutPath.startsWith(prefix)||
  await realpath(checked.stdoutPath)!==checked.stdoutPath||
  !/^[0-9]+-check-r5-programme-[a-f0-9-]{36}\.stdout$/.test(basename(checked.stdoutPath))||
  !m3Same(checked.checkerIdentity,await coalitionCheckerIdentity()))
  throw new CapitalProgramV2Error("CHECK_FAILED","Selected P1 checker custody/runtime changed");
 const physical=await m3Tx(ctx,async c=>(await c.query("SELECT body FROM finnor_os.m3_events WHERE tenant_id=$1 AND principal_id=$2 AND query_id=$3 AND kind='R5_PHYSICAL_CHILD' AND body->>'phase'='check-r5-programme' AND body->>'state'='EXITED' LIMIT 129",
  [ctx.auth.tenantId,ctx.auth.userId,issued.body.queryId])).rows,true);
 if(physical.length>128||!physical.some(event=>event.body.receipt.exitCode===0&&event.body.receipt.physicalExitObserved&&
  m3Same(r2Ref("physical-child",{phase:event.body.phase,invocationId:event.body.invocationId,receipt:event.body.receipt}),checked.physicalRef)&&
  basename(checked.stdoutPath).endsWith("-"+event.body.invocationId+".stdout")))
  throw new CapitalProgramV2Error("CHECK_FAILED","Selected P1 actual physical checker exit is absent");
 const stdout=await readR2Artifact(checked.stdoutPath,1048576);
 if(createHash("sha256").update(stdout).digest("hex")!==checked.stdoutSha256||!m3Same(JSON.parse(stdout),checked.result))
  throw new CapitalProgramV2Error("CHECK_FAILED","Retained independent P1 checker bytes differ");
 if(selection.checker.candidateDigest!==issued.body.module.candidateDigest||
  selection.checker.originalDigest!==issued.body.module.originalDigest||
  (await codeIdentity()).digest!==issued.body.codeDigest)
  throw new CapitalProgramV2Error("STALE_INPUT","Selected P1 source/choice/runtime changed");
 return {...issued.body,ref:value,selection};
}

/** Execute only the checked ordinary owner stages, never generated code or a
 * payment/provider effect. Each callee owns its real durable state and replay. */
export async function runCoalitionOwnerProgramme(ctx:PeMutationContext,value:ExperimentRef){
 const cpu=process.cpuUsage(),started=performance.now();
 assertCoalitionPlanningProfile();
 const issued=await readCoalitionOwnerProgramme(ctx,value),deadline=Date.parse(issued.originalDeadlineAt);
 return m3Tx(ctx,async c=>{
 const locked=(await c.query("SELECT pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) AS locked",
  [ctx.auth.tenantId,"r5-p1:"+issued.queryId])).rows[0]?.locked;
 if(!locked)throw new CapitalProgramV2Error("STALE_INPUT","Original selected P1 owner programme is already running");
 const history=(await c.query("SELECT attempt_id,body FROM finnor_os.m3_events WHERE tenant_id=$1 AND principal_id=$2 AND query_id=$3 AND kind='CHECK' AND body->'moduleRef'->>'contentDigest'=$4 ORDER BY created_at,id LIMIT 257",
  [ctx.auth.tenantId,ctx.auth.userId,issued.queryId,value.contentDigest])).rows;
 const finished=history.find(event=>event.body.phase==="P1_OWNER_HANDOFF_FINISHED");
 if(finished){
  const retained=await readM3Record<Record<string,unknown>>(ctx,"modules",finished.body.ref);
  if(!m3Same(retained.body,finished.body.body))throw new CapitalProgramV2Error("CHECK_FAILED","Retained P1 handoff receipt changed");
  return {...retained.body,ref:finished.body.ref};
 }
 const attempts=history.filter(event=>event.body.phase==="P1_OWNER_HANDOFF_STARTED");
 if(history.length>256||attempts.length>=issued.selection.original.limits.native.maxNativeCalls)
  throw new CapitalProgramV2Error("LIMIT_EXCEEDED","Original bounded P1 owner attempt inventory exhausted");
 if(attempts.some(attempt=>!history.some(event=>event.attempt_id===attempt.attempt_id&&event.body.phase==="P1_OWNER_HANDOFF_FAILED")))
  throw new CapitalProgramV2Error("STALE_INPUT","Original P1 attempt has UNKNOWN cost/responsibility; no refreshed grant is allowed");
 const priorCpu=history.reduce((total,event)=>total+(event.body.phase==="P1_OWNER_HANDOFF_FAILED"?Number(event.body.cpuMs):0),0);
 const remaining=deadline-Date.now(),cpuBudget=issued.remainingCpuMs-priorCpu;
 if(remaining<=0)throw new CapitalProgramV2Error("LIMIT_EXCEEDED","Original selected P1 episode expired; no new grant is issued");
 const checkpoint=()=>{
  const used=process.cpuUsage(cpu);
  if(!Number.isFinite(cpuBudget)||Date.now()>=deadline||(used.user+used.system)/1000>=cpuBudget||
   process.memoryUsage().rss>=issued.selection.original.limits.native.memoryMiB*1048576)
   throw new CapitalProgramV2Error("LIMIT_EXCEEDED","Original selected P1 remaining resources exhausted; partial responsibility retained");
 };
 const stages=issued.module.stages;
 if(!m3Same(stages,["READ_S4_SELECTION","RESERVE_SINGLE_S5","INTEND_SINGLE_S5_CONSUMPTION","PROPOSE_S6_SCHEDULE","STOP_UNADMITTED_EFFECT"]))
  throw new CapitalProgramV2Error("CHECK_FAILED","Selected P1 owner instruction sequence differs");
 const attemptId=randomUUID();
 await m3Event(ctx,issued.queryId,attemptId,"CHECK",{phase:"P1_OWNER_HANDOFF_STARTED",moduleRef:value,originalDeadlineAt:issued.originalDeadlineAt});
 try{return await inM3Episode(remaining,async()=>{
  checkpoint();const selection=await readEnterpriseCoalitionSelection(ctx,issued.module.selectionRef);
  const prefix="r5-p1:"+value.contentDigest;
  checkpoint();const allocation=await clearEnterpriseCoalitionAllocation(ctx,{selectionRef:selection.ref,idempotencyKey:prefix+":reservation"});
  checkpoint();const consumption=await consumeEnterpriseCoalitionAllocation(ctx,{allocationRef:allocation.certificate.ref,idempotencyKey:prefix+":consumption"});
  checkpoint();const schedule=await prepareEnterpriseCoalitionSchedule(ctx,{allocationRef:allocation.certificate.ref,consumptionRef:consumption.ref});
  checkpoint();
  const body={schema:"finnor.p1.coalition-owner-handoff.v1",moduleRef:value,selectionRef:selection.ref,
   allocationRef:allocation.certificate.ref,reservationRef:allocation.reservation!.ref,consumptionRef:consumption.ref,scheduleRef:schedule.ref,
   stage:"STOP_UNADMITTED_EFFECT",executionAuthorityGranted:false,settlementEstablished:false,protectedReceipt:null};
  const ref=m3Ref("coalition-p1-owner-handoff",body);
  await writeM3Record(ctx,"modules",ref,body);
  const used=process.cpuUsage(cpu);
  await m3Event(ctx,issued.queryId,attemptId,"CHECK",{phase:"P1_OWNER_HANDOFF_FINISHED",moduleRef:value,ref,body,
   wallMs:performance.now()-started,cpuMs:(used.user+used.system)/1000,money:null,originalBudgetReplenished:false});
  return {...body,ref};
 });}catch(error){
  const used=process.cpuUsage(cpu);
  await m3Event(ctx,issued.queryId,attemptId,"CHECK",{phase:"P1_OWNER_HANDOFF_FAILED",moduleRef:value,
   wallMs:performance.now()-started,cpuMs:(used.user+used.system)/1000,money:null,
   partialS5ResponsibilityRetained:true,originalBudgetReplenished:false});
  throw error;
 }
 });
}
