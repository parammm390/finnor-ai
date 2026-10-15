import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';

/** Disposable physical SQL contention only. Never imported by product owners. */
export async function startAdmissionCursorReview(input:{connectionString:string;tenant:string;
  save:(name:string,value:unknown)=>Promise<unknown>;assertLive:()=>void}){
  assert.match(input.tenant,/^[0-9a-f-]{36}$/);
  const c=new pg.Client({connectionString:input.connectionString});await c.connect();
  const holder=(await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const scope=randomUUID(),events:any[]=[];let stopped=false,failure:string|null=null,first:number|null=null;
  for(let attempt=1;attempt<=3;attempt++)await c.query('SELECT pg_advisory_lock(hashtextextended($1,$2))',[scope,55190+attempt]);
  // The transaction-local flag means one barrier per complete transaction;
  // the sequence survives rollback so physical attempts remain distinguishable.
  await c.query(`CREATE SEQUENCE finnor_os.x1_cursor_review_attempt;
    CREATE FUNCTION finnor_os.x1_cursor_review_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE ordinal bigint; BEGIN
      IF NEW.tenant_id::text<>'${input.tenant}' OR current_setting('x1_review.cursor_entered',true)='true' THEN RETURN NEW; END IF;
      PERFORM set_config('x1_review.cursor_entered','true',true);
      ordinal:=nextval('finnor_os.x1_cursor_review_attempt');
      IF ordinal<=3 THEN PERFORM pg_advisory_xact_lock(hashtextextended('${scope}',55190+ordinal)); END IF;
      RETURN NEW; END $$;
    CREATE TRIGGER x1_cursor_review BEFORE INSERT ON finnor_os.pe_evidence_links
      FOR EACH ROW EXECUTE FUNCTION finnor_os.x1_cursor_review_barrier()`);
  const run=(async()=>{try{
    const deadline=performance.now()+180000;
    for(let ordinal=1;ordinal<=3&&!stopped;ordinal++){
      let blocked:any;
      while(!stopped&&performance.now()<deadline){
        input.assertLive();blocked=(await c.query(`SELECT pid,usename,backend_xid::text,xact_start,query,wait_event,
          pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE datname=current_database()
          AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%INSERT INTO%pe_evidence_links%'`,[holder])).rows[0];
        if(blocked)break;await new Promise(resolve=>setTimeout(resolve,5));
      }
      if(stopped)break;if(!blocked)throw Error('ACTUAL_CURSOR_BARRIER_NOT_REACHED_WITHIN_ORIGINAL_BOUND');
      assert.equal(blocked.usename,'finnor_worker');
      const enteredAt=new Date().toISOString(),entered=performance.now();first??=entered;
      const elapsedMs=entered-first,forceConflict=elapsedMs<200;
      const before=(await c.query('SELECT last_seq::text FROM finnor_os.tenant_operational_delta_cursors WHERE tenant_id=$1',[input.tenant])).rows[0];
      let eventId:string|null=null;
      if(forceConflict){eventId=randomUUID();await c.query(`INSERT INTO finnor_os.business_events
        (id,tenant_id,entity_type,entity_id,event_type,payload,source)
        VALUES($1,$2,'x1_cursor_fixture_probe',$1,'fixture_cursor_contention',$3::jsonb,'x1_disposable_cursor_review')`,
        [eventId,input.tenant,JSON.stringify({fixtureOnly:true,ordinal,completionCredit:0})]);}
      const after=(await c.query('SELECT last_seq::text FROM finnor_os.tenant_operational_delta_cursors WHERE tenant_id=$1',[input.tenant])).rows[0];
      if(forceConflict)assert.ok(BigInt(after.last_seq)>BigInt(before.last_seq));
      await c.query('SELECT pg_advisory_unlock(hashtextextended($1,$2))',[scope,55190+ordinal]);
      events.push({ordinal,blocked,enteredAt,elapsedMs,forceConflict,eventId,before,after,releasedAt:new Date().toISOString()});
      await input.save('admission-cursor-physical-observations.json',{holder,scope,burstMs:200,maxOriginalAttempts:3,events});
    }
  }catch(error){failure=String((error as Error).message);await c.query('SELECT pg_advisory_unlock_all()');}})();
  const finish=async()=>{stopped=true;await run;await c.query('SELECT pg_advisory_unlock_all()');
    const receipt={holder,scope,burstMs:200,maxOriginalAttempts:3,events,failure,
      actualSeparateSqlWrites:events.some(event=>event.forceConflict&&event.eventId),productCodeOrCompletionManufactured:false};
    await input.save('admission-cursor-physical-receipt.json',receipt);return receipt;};
  return {finish,async close(){await finish();await c.query(`DROP TRIGGER IF EXISTS x1_cursor_review ON finnor_os.pe_evidence_links;
    DROP FUNCTION IF EXISTS finnor_os.x1_cursor_review_barrier();DROP SEQUENCE IF EXISTS finnor_os.x1_cursor_review_attempt`);
    await c.end();}};
}
