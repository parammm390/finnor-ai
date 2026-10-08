import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { hash } from '../../packages/private-equity/src/counterexample-search/contracts';
import { tx,searchRow,retain,load,purgeExpiredPayloads } from '../../packages/private-equity/src/counterexample-search/store';

/** Actual ordinary-role store/SQL boundaries. All expiry fixtures are generated
 * in the disposable database against the accepted Work; no real data is aged. */
export async function storageChallenges(e:any){
  const {f,api,ok,run,challenge,artifact}=e;
  await challenge('retention-holds-and-key-recovery','Work/search/tenant holds prevent deletion; bounded purge retains immutable metadata and authenticated keys recover exact evidence',async()=>{
    const initial=await run(),seed=await searchRow(f.ctx,initial.sent.searchId);
    const fixture=async(count:number)=>tx(f.ctx,async c=>{
      const id=randomUUID(),row=(await c.query(`INSERT INTO finnor_os.m4_searches(
        id,tenant_id,principal_id,work_id,work_input_id,work_input_digest,idempotency_key,
        request_digest,frozen_digest,limits,status,deadline_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'COMPLETED',clock_timestamp()+interval '30 seconds',
        clock_timestamp()-interval '1 second') RETURNING *`,[id,f.tenant,f.principal,seed.work_id,seed.work_input_id,
          seed.work_input_digest,'retention-fixture:'+id,seed.request_digest,seed.frozen_digest,JSON.stringify(seed.limits)])).rows[0];
      const digests=[];
      for(let i=0;i<count;i++)digests.push(await retain(f.ctx,row,'RETENTION_FIXTURE',{schema:'finnor.m4.retention-fixture.v1',id,index:i},c));
      return {row,digests};
    });
    const held=await fixture(1),many=await fixture(129);
    const count=()=>tx(f.ctx,async c=>(await c.query(`SELECT
      (SELECT count(*)::int FROM finnor_os.m4_payloads WHERE search_id=ANY($1::uuid[])) payloads,
      (SELECT count(*)::int FROM finnor_os.m4_records WHERE search_id=ANY($1::uuid[])) metadata`,
      [[held.row.id,many.row.id]])).rows[0],true);
    const before=await count();
    assert.equal(before.payloads,130);assert.equal(before.metadata,130);
    const hold=async(type:string,id:string)=>tx(f.ctx,async c=>(await c.query(
      "INSERT INTO finnor_os.data_retention_holds(tenant_id,resource_type,resource_id,reason,held_by) VALUES($1,$2,$3,'Generated M4 retention qualification',$4) RETURNING id",
      [f.tenant,type,id,f.principal])).rows[0].id);
    const release=async(id:string)=>tx(f.ctx,async c=>{await c.query(
      'UPDATE finnor_os.data_retention_holds SET released_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',[f.tenant,id]);});
    const searchHold=await hold('m4_search',held.row.id),workHold=await hold('work',seed.work_id);
    const allHeld=await purgeExpiredPayloads(f.ctx);assert.equal(allHeld.purgedPayloads,0);
    assert.equal((await load<any>(f.ctx,held.row.id,held.digests[0]!)).id,held.row.id);
    await assert.rejects(tx(f.ctx,c=>c.query('DELETE FROM finnor_os.m4_payloads WHERE search_id=$1',[held.row.id])),/legal hold/);
    await release(workHold);
    await tx(f.ctx,c=>c.query("INSERT INTO finnor_os.tenant_retention_policies(tenant_id,data_class,retention_days,legal_hold) VALUES($1,'m4_evidence',1,true)",[f.tenant]));
    const tenantHeld=await purgeExpiredPayloads(f.ctx);assert.equal(tenantHeld.purgedPayloads,0);
    await tx(f.ctx,c=>c.query("UPDATE finnor_os.tenant_retention_policies SET legal_hold=false WHERE tenant_id=$1 AND data_class='m4_evidence'",[f.tenant]));
    const first=await purgeExpiredPayloads(f.ctx);assert.equal(first.purgedPayloads,128);
    assert.deepEqual(await count(),{payloads:2,metadata:130});
    const second=await purgeExpiredPayloads(f.ctx);assert.equal(second.purgedPayloads,1);
    assert.deepEqual(await count(),{payloads:1,metadata:130});
    await release(searchHold);
    const last=await purgeExpiredPayloads(f.ctx);assert.equal(last.purgedPayloads,1);
    assert.deepEqual(await count(),{payloads:0,metadata:130});
    await assert.rejects(load(f.ctx,held.row.id,held.digests[0]!),(error:any)=>error.code==='UNAVAILABLE');

    const originalKey=process.env.FINNOR_M4_STORAGE_KEY,originalId=process.env.FINNOR_M4_STORAGE_KEY_ID;
    const responses=[];
    try{
      delete process.env.FINNOR_M4_STORAGE_KEY;
      const missing=await api(f,'counterexample-read',{searchId:seed.id});assert.equal(missing.status,503);responses.push({kind:'MISSING_KEY',...missing});
      process.env.FINNOR_M4_STORAGE_KEY=originalKey;process.env.FINNOR_M4_STORAGE_KEY_ID='unavailable-key-version';
      const wrongVersion=await api(f,'counterexample-read',{searchId:seed.id});assert.equal(wrongVersion.status,503);responses.push({kind:'WRONG_KEY_VERSION',...wrongVersion});
      process.env.FINNOR_M4_STORAGE_KEY_ID=originalId;process.env.FINNOR_M4_STORAGE_KEY=randomBytes(32).toString('base64');
      const wrongBytes=await api(f,'counterexample-read',{searchId:seed.id});assert.equal(wrongBytes.status,422);responses.push({kind:'WRONG_KEY_BYTES',...wrongBytes});
    }finally{process.env.FINNOR_M4_STORAGE_KEY=originalKey;process.env.FINNOR_M4_STORAGE_KEY_ID=originalId;}
    const recovered=ok(await api(f,'counterexample-read',{searchId:seed.id}));
    assert.equal(recovered.report.ref.contentDigest,initial.report.ref.contentDigest);
    const corruptDigest=hash({schema:'finnor.m4.corruption-fixture.v1',id:seed.id});
    await tx(f.ctx,async c=>{
      await c.query(`INSERT INTO finnor_os.m4_records(tenant_id,principal_id,search_id,digest,kind,plaintext_bytes)
        SELECT tenant_id,principal_id,search_id,$2,'CORRUPTION_FIXTURE',plaintext_bytes FROM finnor_os.m4_records
        WHERE search_id=$1 AND digest=$3`,[seed.id,corruptDigest,seed.frozen_digest]);
      await c.query(`INSERT INTO finnor_os.m4_payloads(tenant_id,principal_id,search_id,digest,key_id,nonce,tag,ciphertext,expires_at)
        SELECT tenant_id,principal_id,search_id,$2,key_id,nonce,tag,ciphertext,expires_at FROM finnor_os.m4_payloads
        WHERE search_id=$1 AND digest=$3`,[seed.id,corruptDigest,seed.frozen_digest]);
    });
    await assert.rejects(load(f.ctx,seed.id,corruptDigest),(error:any)=>error.code==='CHECK_FAILED');
    await assert.rejects(tx(f.ctx,c=>c.query("UPDATE finnor_os.m4_payloads SET key_id='forged' WHERE search_id=$1",[seed.id])),/permission denied|immutable/);
    await assert.rejects(tx(f.ctx,c=>c.query("UPDATE finnor_os.m4_records SET kind='forged' WHERE search_id=$1",[seed.id])),/permission denied|immutable/);
    const observed={before,allHeld,tenantHeld,first,second,last,after:await count(),keyFailures:responses,
      recoveredRef:recovered.report.ref,corruption:'AUTHENTICATED_DIGEST_BINDING_REFUSED',privateKeyExported:false,
      qualification:'Ordinary disposable native store, not production key custody or an aggregate disk quota'};
    await artifact('storage-retention-recovery.json',observed);return observed;
  });
}
