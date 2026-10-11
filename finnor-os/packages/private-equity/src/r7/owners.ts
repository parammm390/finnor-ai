import type { PoolClient } from 'pg';
import type { PeMutationContext } from '../types';
import type { AffineFamilySource, AtlasOwnerInput, AtlasOriginalPolicy } from '../../../shared-types/src/decision-atlas';
import { principal, resolveDecisionWork } from '../decision-slice/adapters';
import { loadEnterpriseBeliefView, authorizeBeliefResources, validateBeliefViewPin } from '../enterprise-beliefs';
import { assertDependencies, revisions, schemaIdentity } from '../evidence-execution/store';
import { parseAffineFamilySource } from '../../../epistemic-runtime/src/policy-atlas/contracts';
import { AtlasError, atlasHash, atlasRef, bytesHash, rational } from '../../../epistemic-runtime/src/policy-atlas/exact';
import { r7Tx, r7Authorize, r7Family, r7Parameters } from './store';
import { r7Identity } from './runtime';
import { R7Error, r7Unavailable, RegisterSchema, type R7Family, type R7Parameters } from './contracts';
import { withCanonicalAllocationSnapshot } from '../allocation-store';
import { currentExactParameterValues } from './allocation';
import { enqueueOwnerDeliveryInTransaction } from '../../../governed-execution/src/owner-delivery-store';

/** S3 resolves actual immutable authorized S1 bytes, not request coefficients. */
export async function resolveEnterpriseAffineSource(ctx:PeMutationContext,input:{root:R7Family['root'];evidenceVersionId:string}):Promise<{
  source:AffineFamilySource;sourceId:string;pin:AtlasOwnerInput['beliefPins'][number];sourceRef:AtlasOwnerInput['sourceRef'];sourceBytesDigest:string;
}>{
  await authorizeBeliefResources(ctx,[{type:input.root.entityType,id:input.root.entityId},{type:'evidence_source_version',id:input.evidenceVersionId}]);
  const view=await loadEnterpriseBeliefView(ctx,{root:input.root});
  if(view.coverage.canonicalStatus!=='COMPLETE'||view.coverage.truncated||view.contradictions.length)throw new R7Error('UNSUPPORTED','Current S1 recorded cut is incomplete or contradictory');
  const claim=view.claims.find(c=>c.ownerRef.entityType==='evidence_source_version'&&c.ownerRef.id===input.evidenceVersionId);
  if(!claim?.exactSnapshotJson)throw r7Unavailable();
  const raw=JSON.parse(claim.exactSnapshotJson) as Record<string,unknown>;
  let source:AffineFamilySource;
  try{source=parseAffineFamilySource(raw.decisionAtlasSource);}
  catch(error){if(error instanceof AtlasError)throw new R7Error('UNSUPPORTED',error.code);throw error;}
  if(source.mandate.tenantId!==ctx.auth.tenantId||source.mandate.principalId!==principal(ctx)||
    source.mandate.businessOwnerRef.id!==principal(ctx)||Date.now()<Date.parse(source.mandate.knowledgeAt)||
    Date.now()>=Date.parse(source.mandate.validUntil))throw r7Unavailable();
  const row=await r7Tx(ctx,async c=>(await c.query<{source_id:string;snapshot_json:string;content_hash:string}>(
    'SELECT source_id::text,snapshot::text snapshot_json,content_hash FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$2',
    [ctx.auth.tenantId,input.evidenceVersionId])).rows[0]);
  if(!row||row.snapshot_json!==claim.exactSnapshotJson||claim.ownerRef.contentDigest!==atlasHash({content:row.content_hash,snapshot:bytesHash(row.snapshot_json)}))
    throw new R7Error('CHECK_FAILED','S1 original snapshot witness differs from immutable SQL bytes');
  return {source,sourceId:row.source_id,pin:view.pin,sourceRef:{owner:'S1',id:claim.ownerRef.id,version:claim.ownerRef.revisionId,
    contentDigest:claim.ownerRef.contentDigest},sourceBytesDigest:bytesHash(claim.exactSnapshotJson)};
}
export async function registerR7Family(ctx:PeMutationContext,value:unknown){
  const request=RegisterSchema.parse(value),work=await resolveDecisionWork(ctx,request.workId),
    resolved=await resolveEnterpriseAffineSource(ctx,request),code=await r7Identity();
  const dependencies=await revisions(ctx,[`evidence:${resolved.sourceId}`,`work-inputs:${work.id}`,'rights:tenant','m3:s6-effects',
    `m3:root:${request.root.entityType}:${request.root.entityId}`]);
  const input:AtlasOwnerInput={source:resolved.source,sourceRef:resolved.sourceRef,sourceBytesDigest:resolved.sourceBytesDigest,
    familyRef:atlasRef('S4','original-policy-family',{policies:resolved.source.policies,tieOrder:resolved.source.tieOrder}),
    modelRef:atlasRef('S3','complete-affine-model',{worlds:resolved.source.worlds,stateUnits:resolved.source.stateUnits,hard:resolved.source.hardPredicates}),
    domainRef:atlasRef('S4','atlas-domain',resolved.source.domain),work:{id:work.id,inputId:work.inputId,inputDigest:work.inputDigest},
    beliefPins:[resolved.pin],dependencies,rightsRevision:resolved.pin.rightsRevision,codeDigest:code.digest,
    checkerDigest:code.checkerDigest,schemaDigest:await schemaIdentity(ctx)};
  const episodeId=resolved.source.mandate.episodeId,grantRef=atlasRef('M3','r7-original-local-grant',{tenantId:ctx.auth.tenantId,principalId:principal(ctx),
    episodeId,maxInvocations:64,episodeMs:3600000,qualification:'DISPOSABLE_ORDINARY_UNADMITTED_NO_MONEY_GRANT'}),
    cancellationRef=atlasRef('M3','r7-cancellation',{tenantId:ctx.auth.tenantId,principalId:principal(ctx),episodeId});
  const body={root:request.root,sourceId:resolved.sourceId,evidenceVersionId:request.evidenceVersionId,input,episodeId,grantRef,cancellationRef},
    family:R7Family={...body,ref:atlasRef('S3','affine-family',body)};
  return r7Tx(ctx,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7007))',[ctx.auth.tenantId+':'+principal(ctx)+':'+work.id]);
    await r7Authorize(ctx,c);await assertDependencies(ctx,dependencies,c,true);
    const prior=(await c.query<{content_digest:string}>('SELECT content_digest FROM finnor_os.r7_family_heads WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND root_type=$4 AND root_id=$5 FOR UPDATE',
      [ctx.auth.tenantId,principal(ctx),work.id,request.root.entityType,request.root.entityId])).rows[0];
    if(prior?request.expectedFamilyRef?.contentDigest!==prior.content_digest:request.expectedFamilyRef!==null)throw new R7Error('CONFLICT','Exact family head preimage changed');
    await c.query("INSERT INTO finnor_os.r7_episodes(tenant_id,principal_id,episode_id,deadline_at,max_invocations) VALUES($1,$2,$3,clock_timestamp()+interval '3600 seconds',64) ON CONFLICT DO NOTHING",
      [ctx.auth.tenantId,principal(ctx),episodeId]);
    await c.query('INSERT INTO finnor_os.r7_families(tenant_id,principal_id,content_digest,work_id,root_type,root_id,body) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING',
      [ctx.auth.tenantId,principal(ctx),family.ref.contentDigest,work.id,request.root.entityType,request.root.entityId,JSON.stringify(family)]);
    for(const policy of family.input.source.policies){
      const {ref,...content}=policy;
      await enqueueOwnerDeliveryInTransaction(c,{semanticOwner:'S4',tenantId:ctx.auth.tenantId,principalId:principal(ctx)},
        {kind:'REFERENCE',identity:ref.id,payload:{reference:{...ref,content},rightsRefs:[family.input.source.mandate.rightsRef]}});
    }
    await c.query('INSERT INTO finnor_os.r7_family_heads(tenant_id,principal_id,work_id,root_type,root_id,content_digest) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,principal_id,work_id,root_type,root_id) DO UPDATE SET content_digest=excluded.content_digest',
      [ctx.auth.tenantId,principal(ctx),work.id,request.root.entityType,request.root.entityId,family.ref.contentDigest]);
    if(prior&&prior.content_digest!==family.ref.contentDigest)await c.query("UPDATE finnor_os.r7_builds SET status='INVALIDATED',generation=generation+1,failure=$4::jsonb,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND family_digest=$3 AND status NOT IN('CANCELLED','FAILED','INVALIDATED')",
      [ctx.auth.tenantId,principal(ctx),prior.content_digest,JSON.stringify({code:'STRUCTURAL_FAMILY_REVISION',requirement:'Original source/model/family changed; historical bytes and costs retained'})]);
    const pBody={familyRef:family.ref,revision:1,priorRef:null,values:family.input.source.parameterValues,owner:'BUSINESS_OWNER' as const,createdAt:new Date().toISOString()},
      parameters:R7Parameters={...pBody,ref:atlasRef('BUSINESS_OWNER','atlas-parameters',pBody)};
    const existing=(await c.query('SELECT content_digest FROM finnor_os.r7_parameter_heads WHERE tenant_id=$1 AND principal_id=$2 AND family_digest=$3',
      [ctx.auth.tenantId,principal(ctx),family.ref.contentDigest])).rows[0];
    if(!existing){await c.query('INSERT INTO finnor_os.r7_parameters(tenant_id,principal_id,content_digest,family_digest,revision,body) VALUES($1,$2,$3,$4,1,$5::jsonb)',
      [ctx.auth.tenantId,principal(ctx),parameters.ref.contentDigest,family.ref.contentDigest,JSON.stringify(parameters)]);
      await c.query('INSERT INTO finnor_os.r7_parameter_heads(tenant_id,principal_id,family_digest,content_digest) VALUES($1,$2,$3,$4)',
        [ctx.auth.tenantId,principal(ctx),family.ref.contentDigest,parameters.ref.contentDigest]);}
    return {family,parameters:await r7Parameters(ctx,family,c)};
  });
}
export async function assertR7Owner(ctx:PeMutationContext,family:R7Family,c?:PoolClient){
  const work=await resolveDecisionWork(ctx,family.input.work.id),code=await r7Identity();
  if(work.inputId!==family.input.work.inputId||work.inputDigest!==family.input.work.inputDigest||
    code.digest!==family.input.codeDigest||code.checkerDigest!==family.input.checkerDigest)throw new R7Error('STALE_INPUT','Original Work/method binding changed');
  if(await schemaIdentity(ctx)!==family.input.schemaDigest)throw new R7Error('STALE_INPUT','Original installed schema changed');
  await authorizeBeliefResources(ctx,[{type:family.root.entityType,id:family.root.entityId},{type:'evidence_source_version',id:family.evidenceVersionId}]);
  for(const pin of family.input.beliefPins)if((await validateBeliefViewPin(ctx,pin)).status!=='CURRENT')throw new R7Error('STALE_INPUT','Original S1/rights/interpretation changed');
  await assertDependencies(ctx,family.input.dependencies,c,Boolean(c));
  const read=async(client:PoolClient)=>{
    await r7Authorize(ctx,client);
    const head=(await client.query<{content_digest:string}>(
      'SELECT content_digest FROM finnor_os.r7_family_heads WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND root_type=$4 AND root_id=$5'+(c?' FOR SHARE':''),
      [ctx.auth.tenantId,principal(ctx),work.id,family.root.entityType,family.root.entityId])).rows[0];
    if(head?.content_digest!==family.ref.contentDigest)throw new R7Error('STALE_INPUT','Original family head changed');
    if((await client.query("SELECT id FROM finnor_os.business_effects WHERE tenant_id=$1 AND status NOT IN('verified','cancelled','compensated') LIMIT 1",
      [ctx.auth.tenantId])).rows.length)throw new R7Error('STALE_INPUT','S6 outstanding effect interpretation requires qualified reconciliation');
    if(Date.now()>=Date.parse(family.input.source.mandate.validUntil))throw new R7Error('STALE_INPUT','Original mandate expired');
  };if(c)await read(c);else await r7Tx(ctx,read);
}
export async function reviseR7Parameters(ctx:PeMutationContext,ref:R7Family['ref'],expectedRef:R7Parameters['ref'],values:string[]){
  const family=await r7Family(ctx,ref);await assertR7Owner(ctx,family);
  const specs=family.input.source.domain.parameters;
  if(values.length!==specs.length)throw new R7Error('UNSUPPORTED','Parameter dimension differs');
  values.forEach(v=>rational(v,256));
  return withCanonicalAllocationSnapshot(ctx,async(c,snapshot)=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7008))',[ctx.auth.tenantId+':'+principal(ctx)+':'+ref.contentDigest]);
    await r7Authorize(ctx,c);await assertDependencies(ctx,family.input.dependencies,c,true);await assertR7Owner(ctx,family,c);
    const current=await r7Parameters(ctx,family,c);
    if(atlasHash(current.ref)!==atlasHash(expectedRef))throw new R7Error('CONFLICT','Parameter revision changed');
    const effective=currentExactParameterValues(family.input.source,snapshot,current.values);
    if(specs.some((p,i)=>p.owner==='S5'&&values[i]!==effective[i]))
      throw new R7Error('UNSUPPORTED','S5 parameters can only be sourced from current canonical availability');
    const revised=values.map((v,i)=>specs[i]!.owner==='BUSINESS_OWNER'?v:current.values[i]!);
    const body={familyRef:ref,revision:current.revision+1,priorRef:current.ref,values:revised,owner:'BUSINESS_OWNER' as const,createdAt:new Date().toISOString()},
      result:R7Parameters={...body,ref:atlasRef('BUSINESS_OWNER','atlas-parameters',body)};
    await c.query('INSERT INTO finnor_os.r7_parameters(tenant_id,principal_id,content_digest,family_digest,revision,body) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
      [ctx.auth.tenantId,principal(ctx),result.ref.contentDigest,ref.contentDigest,result.revision,JSON.stringify(result)]);
    await c.query('UPDATE finnor_os.r7_parameter_heads SET content_digest=$4 WHERE tenant_id=$1 AND principal_id=$2 AND family_digest=$3',
      [ctx.auth.tenantId,principal(ctx),ref.contentDigest,result.ref.contentDigest]);
    return result;
  });
}
/** Versioned S4 reader for original affine templates, not the legacy numeric
 * policy contract. Every batch resolves the immutable owner SQL preimage. */
export async function readEnterpriseAffinePolicyContexts(ctx:PeMutationContext,ref:R7Family['ref'],
  policyRefs:AtlasOriginalPolicy['ref'][]){
  if(!policyRefs.length||policyRefs.length>16||new Set(policyRefs.map(p=>p.id)).size!==policyRefs.length)
    throw new R7Error('UNSUPPORTED','Exact-affine owner batch must contain 1–16 distinct original refs');
  return r7Tx(ctx,async c=>{
    const family=await r7Family(ctx,ref,c);await assertR7Owner(ctx,family,c);
    const policies=policyRefs.map(requested=>{
      const original=family.input.source.policies.find(p=>atlasHash(p.ref)===atlasHash(requested));
      if(!original)throw r7Unavailable();
      return original;
    });
    return {familyRef:family.ref,policies,coherentRevisionVector:family.input.dependencies,
      contract:'s4-exact-affine-v1' as const};
  });
}
/** Coherent versioned batches, preserving the old 16-context caller contract. */
export async function readEnterpriseAffinePolicyFamily(ctx:PeMutationContext,ref:R7Family['ref']){
  const family=await r7Family(ctx,ref);await assertR7Owner(ctx,family);
  const policies:AtlasOriginalPolicy[]=[];
  for(let offset=0;offset<family.input.source.policies.length;offset+=16){
    const refs=family.input.source.policies.slice(offset,offset+16).map(p=>p.ref),
      batch=await readEnterpriseAffinePolicyContexts(ctx,ref,refs);
    if(atlasHash(batch.coherentRevisionVector)!==atlasHash(family.input.dependencies))
      throw new R7Error('STALE_INPUT','Original owner vector changed between exact-affine batches');
    policies.push(...batch.policies);
  }
  if(atlasHash(policies)!==atlasHash(family.input.source.policies))throw new R7Error('CHECK_FAILED','Named family omitted or reordered');
  await assertR7Owner(ctx,family);
  return {family,policies,coherentRevisionVector:family.input.dependencies,batchLimit:16,fullFamilyOptimizerInvoked:false};
}
