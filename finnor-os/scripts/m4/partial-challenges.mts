/** Real SQL timeout and ordinary encrypted evidence exhaustion after accepted checking. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tx,searchRow,retain,TERMINAL_EVIDENCE_RESERVE } from '../../packages/private-equity/src/counterexample-search/store';
import { canonicalJson } from '../../packages/epistemic-runtime/src/source-precedence';
import { receiveWork } from '@finnor/db';

export async function partialChallenges(e:any){
  const {repo,f,admin,api,ok,queue,request,challenge,artifact,children}=e;
  await challenge('partial-failure-deadline-and-byte-refusal',
    'No late publication, but accepted original independent evidence survives real parent SQL timeout and root byte refusal, including a cold read',async()=>{
    const observations:any[]=[];
    const compile=async()=>ok(await api(f,'decision-slice-compile',{schema:'finnor.decision-slice-request.v1',workId:f.workId,
      source:{kind:'UNDERWRITING',investmentCaseId:f.caseId,modelVersionId:f.versionId},purpose:'MODEL_EVIDENCE',
      resource:{deadlineMs:30000,maxNodes:2048,maxBytes:4194304,maxDemands:128}})).slice;
    await admin.query(`CREATE TABLE finnor_os.m4_e2e_partial_pause(search_id uuid PRIMARY KEY);
      GRANT SELECT ON finnor_os.m4_e2e_partial_pause TO finnor_app;
      CREATE FUNCTION finnor_os.m4_e2e_partial_pause() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.kind='VALID_ORIGINAL' AND EXISTS(SELECT 1 FROM finnor_os.m4_e2e_partial_pause WHERE search_id=NEW.search_id)
        THEN PERFORM pg_sleep(8); END IF; RETURN NEW; END $$;
      CREATE TRIGGER m4_e2e_partial_pause BEFORE INSERT ON finnor_os.m4_events
        FOR EACH ROW EXECUTE FUNCTION finnor_os.m4_e2e_partial_pause();`);
    try{
      const slice=await compile(),body={...request,sliceRef:slice.ref,idempotencyKey:randomUUID(),
        domain:{parameters:[],maxCombination:1},
        evaluations:[{...request.evaluations[0],value:'-1'}],limits:{...request.limits,maxReductions:0}};
      const deadline=ok(await api(f,'counterexample-diagnostic-submit',{...body,idempotencyKey:randomUUID(),
        limits:{...body.limits,deadlineMs:5000}}),202);
      await admin.query('INSERT INTO finnor_os.m4_e2e_partial_pause VALUES($1)',[deadline.searchId]);
      const start=performance.now();await queue.tick();
      const expired=ok(await api(f,'counterexample-ledger',{searchId:deadline.searchId}));
      observations.push({kind:'PARENT_SQL_DEADLINE',wallMs:performance.now()-start,read:expired});
      await artifact('partial/deadline.json',observations[0]);
      await admin.query('DELETE FROM finnor_os.m4_e2e_partial_pause WHERE search_id=$1',[deadline.searchId]);
      const activePermits=(await admin.query(`SELECT count(*)::int count FROM finnor_os.compute_resource_leases
        WHERE resource_key='provider:m4-native' AND tenant_key=$1 AND released_at IS NULL AND expires_at>clock_timestamp()`,[f.tenant])).rows[0].count;
      assert.equal(activePermits,0,'Expired checking stranded its actual compute permit');

      const raced=ok(await api(f,'counterexample-diagnostic-submit',{...body,idempotencyKey:randomUUID()}),202);
      await admin.query('INSERT INTO finnor_os.m4_e2e_partial_pause VALUES($1)',[raced.searchId]);
      const racing=queue.tick();
      let paused=false;
      for(let i=0;i<200;i++){
        const active=(await admin.query("SELECT count(*)::int count FROM pg_stat_activity WHERE usename='finnor_app' AND wait_event='PgSleep'")).rows[0].count;
        if(active){paused=true;break;}
        await new Promise(yes=>setTimeout(yes,50));
      }
      assert(paused,'The real accepted-check publication race never reached its SQL pause');
      await receiveWork({tenantId:f.tenant,userId:f.principal,workId:f.workId,channel:'console',
        instruction:'Actual owner input changed during retained CHECK, current publication must refuse',
        idempotencyKey:randomUUID()});
      await racing;
      const stale=ok(await api(f,'counterexample-ledger',{searchId:raced.searchId}));
      await admin.query('DELETE FROM finnor_os.m4_e2e_partial_pause WHERE search_id=$1',[raced.searchId]);
      await artifact('partial/currentness-race.json',stale);
      assert.equal(stale.status,'STALE');
      assert.equal(stale.report,null);
      assert.equal(stale.partialEvidence?.result,'FAILURE_WITNESS');
      assert.equal(stale.partialEvidence?.currentUsePermitted,false);
      assert.equal(stale.applicability.status,'STALE');

      const freshBody={...body,sliceRef:(await compile()).ref};
      const control=ok(await api(f,'counterexample-diagnostic-submit',{...freshBody,idempotencyKey:randomUUID()}),202);
      await queue.tick();const complete=ok(await api(f,'counterexample-ledger',{searchId:control.searchId}));
      assert.equal(complete.report.result,'FAILURE_WITNESS');
      const beforeWitness=complete.ledger.slice(1,complete.ledger.findIndex((v:any)=>v.kind==='WITNESS'));
      const beforeBytes=beforeWitness.reduce((n:number,v:any)=>n+Buffer.byteLength(canonicalJson({
        attemptId:v.attemptId,kind:v.kind,body:v.body,recordId:randomUUID()})),0);
      const limited=ok(await api(f,'counterexample-diagnostic-submit',{...freshBody,idempotencyKey:randomUUID()}),202);
      // Fill through the actual ordinary encrypted store. No byte counter or
      // accepted checker metadata is forged. Leave room through VALID_ORIGINAL,
      // but not through the WITNESS event observed in the control.
      const used=Number((await searchRow(f.ctx,limited.searchId)).retained_bytes);
      let fill=8388608-TERMINAL_EVIDENCE_RESERVE-used-beforeBytes-128;
      for(let index=0;fill>0;index++){
        const bytes=Math.min(fill,4194304),payload='x'.repeat(bytes-2);
        await tx(f.ctx,async c=>retain(f.ctx,await searchRow(f.ctx,limited.searchId,c,true),'E2E_BYTE_PRESSURE',payload,c));
        fill-=bytes;
      }
      await queue.tick();const refused=ok(await api(f,'counterexample-ledger',{searchId:limited.searchId}));
      observations.push({kind:'ROOT_BYTE_REFUSAL',read:refused,beforeBytes,control:complete.report.ref});
      await artifact('partial/byte-refusal.json',observations[1]);
      const path=await artifact('partial/cold-input.json',{tenantId:f.tenant,principalId:f.principal,searchId:limited.searchId});
      const child=spawn(process.execPath,['--import=tsx',join(repo,'finnor-os/scripts/m4/cold.mts'),path],{
        cwd:join(repo,'finnor-os'),env:process.env,stdio:['ignore','ignore','pipe','ipc']});
      children.add(child);
      const cold=await new Promise<any>((yes,no)=>{child.once('message',yes);child.once('error',no);
        child.once('exit',code=>{if(code)no(Error('Cold partial evidence process failed'));});});
      await new Promise<void>(yes=>child.exitCode===null?child.once('exit',()=>yes()):yes());children.delete(child);
      await artifact('partial/cold-read.json',cold);
      assert.equal(expired.status,'EXPIRED');assert.equal(expired.report,null);
      assert(expired.ledger.some((v:any)=>v.kind==='CHECK'&&v.body.validation?.status==='VALID'));
      assert.equal(expired.partialEvidence?.result,'FAILURE_WITNESS','A committed accepted check vanished after the deadline');
      assert.equal(expired.partialEvidence?.currentUsePermitted,false);
      assert.equal(refused.report,null);assert.equal(refused.status,'EXPIRED');
      assert(refused.ledger.some((v:any)=>v.kind==='VALID_ORIGINAL'),'Byte refusal did not occur after accepted-original retention');
      assert.equal(refused.partialEvidence?.result,'FAILURE_WITNESS','Root bytes erased the accepted original');
      assert(refused.ledger.some((v:any)=>v.kind==='FAILED'),'Byte refusal could not retain bounded terminal accounting');
      assert.equal(cold.status,200);assert.equal(cold.body.partialEvidence?.ref.contentDigest,refused.partialEvidence.ref.contentDigest);
      assert(refused.retainedBytes<=8388608);
      return {deadlineStatus:expired.status,byteStatus:refused.status,coldRetainedFailure:true,
        latePublication:false,aggregatePhysicalDeadline:'UNQUALIFIED'};
    }finally{
      await admin.query(`DROP TRIGGER m4_e2e_partial_pause ON finnor_os.m4_events;
        DROP FUNCTION finnor_os.m4_e2e_partial_pause();DROP TABLE finnor_os.m4_e2e_partial_pause`);
    }
  });
}
