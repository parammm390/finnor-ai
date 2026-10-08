import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { JobQueue,type JobExecutionContext } from '../../apps/worker/src/queue';
import { runCounterexampleSearchJob } from '../../packages/private-equity/src/counterexample-search/worker';
import { tx,searchRow,fence } from '../../packages/private-equity/src/counterexample-search/store';

/** Real process and SQL crash windows. Fixture triggers alter no business owner. */
export async function recoveryChallenges(e:any){
  const {f,repo,admin,api,ok,challenge,artifact,request,children}=e;
  await challenge('physical-crash-recovery-and-fences','Canonical recovery preserves committed checks/witnesses/report and exhausted parent debits after real SIGKILL; stale claims cannot publish',async()=>{
    const observations:any[]=[],tables:string[]=[];
    try{
      await admin.query("UPDATE finnor_os.compute_resource_policies SET lease_seconds=15 WHERE resource_key='provider:m4-native'");
      await admin.query("CREATE TABLE finnor_os.m4_e2e_pause(search_id uuid PRIMARY KEY,pause_kind text NOT NULL)");
      await admin.query("GRANT SELECT ON finnor_os.m4_e2e_pause TO finnor_app");
      tables.push('fixture');
      await admin.query(`CREATE FUNCTION finnor_os.m4_e2e_event_pause() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF EXISTS(SELECT 1 FROM finnor_os.m4_e2e_pause WHERE search_id=NEW.search_id AND pause_kind=NEW.kind)
          THEN PERFORM pg_sleep(10); END IF; RETURN NEW; END $$;
        CREATE TRIGGER m4_e2e_event_pause BEFORE INSERT ON finnor_os.m4_events FOR EACH ROW EXECUTE FUNCTION finnor_os.m4_e2e_event_pause();
        CREATE FUNCTION finnor_os.m4_e2e_search_pause() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.status='COMPLETED' AND OLD.status<>'COMPLETED' AND EXISTS(
          SELECT 1 FROM finnor_os.m4_e2e_pause WHERE search_id=NEW.id AND pause_kind='PUBLICATION')
          THEN PERFORM pg_sleep(10); END IF; RETURN NEW; END $$;
        CREATE TRIGGER m4_e2e_search_pause BEFORE UPDATE ON finnor_os.m4_searches FOR EACH ROW EXECUTE FUNCTION finnor_os.m4_e2e_search_pause();
        CREATE FUNCTION finnor_os.m4_e2e_ack_pause() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.status='completed' AND OLD.status='running' AND EXISTS(
          SELECT 1 FROM finnor_os.m4_e2e_pause WHERE search_id=(NEW.payload->>'searchId')::uuid AND pause_kind='ACK')
          THEN PERFORM pg_sleep(10); END IF; RETURN NEW; END $$;
        CREATE TRIGGER m4_e2e_ack_pause BEFORE UPDATE ON finnor_os.jobs FOR EACH ROW EXECUTE FUNCTION finnor_os.m4_e2e_ack_pause();`);
      // Trigger schema is now part of the frozen cut. Control rows change only
      // which selected native test transaction is paused.
      const fresh=ok(await api(f,'decision-slice-compile',{schema:'finnor.decision-slice-request.v1',workId:f.workId,
        source:{kind:'UNDERWRITING',investmentCaseId:f.caseId,modelVersionId:f.versionId},purpose:'MODEL_EVIDENCE',
        resource:{deadlineMs:30000,maxNodes:2048,maxBytes:4194304,maxDemands:128}})).slice;
      for(const window of ['CHECK','WITNESS','PUBLICATION','ACK']){
        const sent=ok(await api(f,'counterexample-diagnostic-submit',{...request,sliceRef:fresh.ref,idempotencyKey:randomUUID(),
          evaluations:[{...request.evaluations[0],value:'-1'}],domain:{parameters:[],maxCombination:1},
          limits:{...request.limits,maxTrials:2,maxWitnesses:1,maxReductions:0}}),202);
        const acceptedDeadline=(await searchRow(f.ctx,sent.searchId)).deadline_at.getTime();
        await admin.query('INSERT INTO finnor_os.m4_e2e_pause(search_id,pause_kind) VALUES($1,$2)',[sent.searchId,window]);
        const path=await artifact('recovery/child-'+window+'.json',{workerId:'m4-physical-'+window,searchId:sent.searchId});
        const childUrl=new URL(process.env.DATABASE_URL!);childUrl.searchParams.set('application_name','m4-physical-'+window);
        const spawnedAt=new Date().toISOString();
        const child=spawn(process.execPath,['--import=tsx',join(repo,'finnor-os/scripts/m4/physical-worker.mts'),path],
          {cwd:join(repo,'finnor-os'),env:{...process.env,DATABASE_URL:childUrl.href},stdio:['ignore','pipe','pipe']});
        children.add(child);let stderr='',stdout='';
        child.stderr!.on('data',b=>{stderr+=(b as Buffer).toString();if(stderr.length>8192)stderr=stderr.slice(-8192);});
        child.stdout!.on('data',b=>{stdout+=(b as Buffer).toString();if(stdout.length>8192)stdout=stdout.slice(-8192);});
        const exit=new Promise<any>(yes=>child.once('exit',(code,signal)=>yes({code,signal})));
        let paused:any;
        const observationStarted=performance.now();
        const observationBudgetMs=Math.max(0,Math.min(12000,acceptedDeadline-Date.now()-16200));
        const observationCeiling=observationStarted+observationBudgetMs;
        const polls:any[]=[];
        while(performance.now()<observationCeiling){
          const pollStarted=performance.now(),pollAt=new Date().toISOString();
          paused=(await admin.query(`SELECT pid,query,wait_event FROM pg_stat_activity
            WHERE datname=current_database() AND application_name=$1 AND wait_event='PgSleep'
              AND pid<>pg_backend_pid() ORDER BY query_start LIMIT 1`,['m4-physical-'+window])).rows[0];
          polls.push({pollAt,elapsedMs:performance.now()-pollStarted,
            observationElapsedMs:performance.now()-observationStarted,remainingParentMs:acceptedDeadline-Date.now(),
            observedPause:paused?{query:paused.query,waitEvent:paused.wait_event}:null,
            childExitCode:child.exitCode,childSignal:child.signalCode});
          if(paused||child.exitCode!==null||child.signalCode!==null)break;
          await new Promise(yes=>setTimeout(yes,50));
        }
        const selectedState=(await admin.query(`SELECT s.id,s.status,s.trials,s.created_at,s.deadline_at,j.status job_status,j.lease_owner,
          (SELECT jsonb_agg(jsonb_build_object('kind',e.kind,'at',e.created_at) ORDER BY e.created_at,e.id)
            FROM finnor_os.m4_events e WHERE e.search_id=s.id) events
          FROM finnor_os.m4_searches s JOIN finnor_os.jobs j ON j.id=s.job_id WHERE s.id=$1`,[sent.searchId])).rows[0];
        await artifact('recovery/boundary-'+window+'.json',{window,spawnedAt,observedAt:new Date().toISOString(),
          stdout,stderr,observationBudgetMs,recoveryReservedMs:16200,
          observationElapsedMs:performance.now()-observationStarted,remainingParentMs:acceptedDeadline-Date.now(),
          polls,paused:paused?{query:paused.query,waitEvent:paused.wait_event}:null,selectedState});
        assert(paused,'Actual '+window+' SQL boundary was not observed');
        assert.equal(selectedState.lease_owner,'m4-physical-'+window,'Observed pause did not belong to the actual selected claim');
        const before=ok(await api(f,'counterexample-ledger',{searchId:sent.searchId})),
          claim=(await admin.query(`SELECT id,tenant_id,payload,claim_token,claim_fence,lease_owner,lease_expires_at,
            (SELECT id FROM finnor_os.job_delivery_attempts WHERE job_id=j.id AND claim_token=j.claim_token AND outcome='running') delivery_id
            FROM finnor_os.jobs j WHERE payload->>'searchId'=$1`,[sent.searchId])).rows[0];
        const observeLeaseClock=async()=>(await admin.query(`SELECT j.id,j.status,j.claim_fence,j.lease_owner,
          d.id delivery_id,d.outcome delivery_outcome,a.attempt_id,clock_timestamp() server_now,
          j.lease_expires_at job_expires_at,l.provider_leases,
          greatest(coalesce(j.lease_expires_at,clock_timestamp()),coalesce(l.provider_until,clock_timestamp())) ready_at,
          greatest(0,extract(epoch FROM(greatest(coalesce(j.lease_expires_at,clock_timestamp()),
            coalesce(l.provider_until,clock_timestamp()))-clock_timestamp()))*1000)::float8 remaining_ms
          FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts d ON d.id=$2 AND d.job_id=j.id
          LEFT JOIN LATERAL(SELECT e.attempt_id FROM finnor_os.m4_events e
            WHERE e.tenant_id=j.tenant_id AND e.principal_id=$4 AND e.search_id=$3 AND e.kind='STARTED'
              AND e.created_at>=d.started_at ORDER BY e.created_at DESC,e.id DESC LIMIT 1) a ON true
          LEFT JOIN LATERAL(SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id',p.id,'resourceKey',p.resource_key,'ownerId',p.owner_id,'fence',p.fence,
            'expiresAt',p.expires_at,'heartbeatAt',p.heartbeat_at,'releasedAt',p.released_at)),'[]'::jsonb) provider_leases,
            max(p.expires_at) FILTER(WHERE p.released_at IS NULL) provider_until
            FROM finnor_os.compute_resource_leases p WHERE p.resource_key='provider:m4-native'
              AND p.tenant_key=j.tenant_key AND p.owner_id=a.attempt_id::text) l ON true
          WHERE j.id=$1`,[claim.id,claim.delivery_id,sent.searchId,f.principal])).rows[0];
        const beforeKillLeases=await observeLeaseClock();
        await artifact('recovery/leases-before-kill-'+window+'.json',beforeKillLeases);
        assert.equal(beforeKillLeases.delivery_outcome,'running');
        assert(beforeKillLeases.attempt_id,'Selected native provider attempt was not observed');
        assert(beforeKillLeases.provider_leases.length,'Exact selected provider capacity lease was not observed');
        child.kill('SIGKILL');const killed=await exit;children.delete(child);assert.equal(killed.signal,'SIGKILL');
        await admin.query('SELECT pg_terminate_backend($1)',[paused.pid]);
        await admin.query('DELETE FROM finnor_os.m4_e2e_pause WHERE search_id=$1',[sent.searchId]);
        const recovering=new JobQueue('m4-recovered-'+window,3);
        const recoveryContract={protocolVersions:[1],retrySafety:'locally_idempotent' as const,
          leaseRecovery:'immediate_after_expiry' as const};
        recovering.register('run_counterexample_search_v1',runCounterexampleSearchJob,recoveryContract);
        const unexpired=await observeLeaseClock();
        if(unexpired.job_expires_at.getTime()>unexpired.server_now.getTime()+100){
          assert.equal(await recovering.recoverExpiredRunningJobs(3),0,'A live physical claim was recovered before actual lease expiry');
        }
        // No live worker or native child is released by this test. Wait for the
        // exact killed delivery/provider server expiry, not another full lease.
        const leaseObservations=[unexpired],waitStarted=performance.now();
        let ready=unexpired;
        while(ready.remaining_ms>0){
          await artifact('recovery/lease-wait-'+window+'.json',{beforeKillLeases,leaseObservations,
            acceptedDeadline:new Date(acceptedDeadline).toISOString(),elapsedMs:performance.now()-waitStarted});
          assert.equal(Number(ready.claim_fence),Number(claim.claim_fence));
          assert.equal(ready.lease_owner,claim.lease_owner);
          assert(ready.remaining_ms<acceptedDeadline-ready.server_now.getTime(),
            'Actual killed delivery/provider lease cannot expire within the original parent deadline');
          await new Promise(yes=>setTimeout(yes,Math.ceil(ready.remaining_ms)+1));
          ready=await observeLeaseClock();leaseObservations.push(ready);
        }
        const leaseWait={beforeKillLeases,leaseObservations,ready,elapsedMs:performance.now()-waitStarted,
          replacedFixedPostKillWaitMs:15200,usesServerClock:true,mutatedOrReleasedLease:false};
        await artifact('recovery/lease-wait-'+window+'.json',leaseWait);
        assert(ready.job_expires_at.getTime()<=ready.server_now.getTime());
        assert(ready.provider_leases.every((p:any)=>p.releasedAt!==null||Date.parse(p.expiresAt)<=ready.server_now.getTime()));
        assert.equal(await recovering.recoverExpiredRunningJobs(3),1);
        const schedule=(await admin.query('SELECT status,run_at,claim_token,claim_fence,attempts FROM finnor_os.jobs WHERE id=$1',[claim.id])).rows[0];
        const retained=await searchRow(f.ctx,sent.searchId);
        const snapshot={window,sent,killed,paused:{query:paused.query,waitEvent:paused.wait_event},
          before,recoveryContract,unexpired,leaseWait,recoveredSchedule:schedule,parentDeadline:retained.deadline_at.toISOString()};
        observations.push(snapshot);await artifact('recovery/observed-'+window+'.json',snapshot);
        assert.equal(retained.deadline_at.getTime(),acceptedDeadline,'Recovery renewed the accepted parent deadline');
        assert.equal(schedule.claim_token,null,'Lost physical claim retained publication authority');
        assert.equal(Number(schedule.claim_fence),Number(claim.claim_fence));
        assert.equal(schedule.attempts,1,'Physical crash refunded the consumed delivery attempt');
        assert(schedule.run_at.getTime()<retained.deadline_at.getTime(),'Canonical recovery deferred beyond the one parent deadline');
        const old:JobExecutionContext={jobId:claim.id,tenantId:f.tenant,deliveryAttemptId:claim.delivery_id,
          claimToken:claim.claim_token,claimFence:Number(claim.claim_fence),workerId:claim.lease_owner,
          protocolVersion:1,retrySafety:'locally_idempotent',registerHeartbeat:()=>undefined};
        await assert.rejects(tx(f.ctx,c=>fence(f.ctx,retained,old,c)),(error:any)=>error.code==='CANCELLED');
        await recovering.tick();
        const after=ok(await api(f,'counterexample-ledger',{searchId:sent.searchId}));
        await artifact('recovery/after-'+window+'.json',after);
        assert.equal(after.status,'COMPLETED',JSON.stringify(after));
        assert.equal(after.report.result,window==='CHECK'?'BLOCKED':'FAILURE_WITNESS');
        assert.equal(after.trials,2,'Crash acquired a fresh parent trial allowance');
        assert.equal(after.report.witnesses.length,window==='CHECK'?0:1);
        if(window==='ACK'){
          assert.equal(after.report.ref.contentDigest,before.report.ref.contentDigest);
          assert.equal(after.ledger.filter((v:any)=>v.kind==='FINISHED').length,1);
        }else{
          assert(after.ledger.some((v:any)=>v.kind==='FENCED'));
          assert.equal(after.report.ledger.unknownAttemptCosts,true);
        }
        const deliveries=(await admin.query('SELECT claim_fence,outcome FROM finnor_os.job_delivery_attempts WHERE job_id=$1 ORDER BY started_at,id',[claim.id])).rows;
        assert.deepEqual(deliveries.map((v:any)=>v.outcome),['lease_lost','completed']);
        assert.equal(after.deliveryHistory.length,2);assert(after.deliveryHistory[0].finalPhysicalCostUnknown);
        assert(after.deliveryHistory.every((entry:any)=>!('claimToken'in entry)&&entry.costUSD===null));
        await artifact('recovery/settled-'+window+'.json',{after,deliveries});
      }
      const unsafe=new JobQueue('m4-unsafe-recovery-control',3),
        unsafeContract={protocolVersions:[1],retrySafety:'durably_effect_guarded' as const,
          leaseRecovery:'immediate_after_expiry' as const};
      assert.throws(()=>unsafe.register('m4-test-consequential-recovery',async()=>{},unsafeContract),
        /Immediate expired-lease recovery requires a locally idempotent handler/);
      return {windows:observations.map(v=>v.window),realSignals:'SIGKILL',oneParentTrials:2,protectedOrphanConfinement:'UNQUALIFIED'};
    }finally{
      await admin.query("UPDATE finnor_os.compute_resource_policies SET lease_seconds=120 WHERE resource_key='provider:m4-native'");
      if(tables.length)await admin.query(`DROP TRIGGER IF EXISTS m4_e2e_event_pause ON finnor_os.m4_events;
        DROP TRIGGER IF EXISTS m4_e2e_search_pause ON finnor_os.m4_searches;DROP TRIGGER IF EXISTS m4_e2e_ack_pause ON finnor_os.jobs;
        DROP FUNCTION IF EXISTS finnor_os.m4_e2e_event_pause();DROP FUNCTION IF EXISTS finnor_os.m4_e2e_search_pause();
        DROP FUNCTION IF EXISTS finnor_os.m4_e2e_ack_pause();DROP TABLE finnor_os.m4_e2e_pause`);
    }
  });
}
