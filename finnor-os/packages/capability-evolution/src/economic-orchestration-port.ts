import type {PoolClient} from 'pg';
import type {PeMutationContext} from '../../private-equity/src/types';
import type {SearchRow} from '../../private-equity/src/compute-search/contracts';
import type {ProgramRow} from '../../private-equity/src/program-synthesis/store';
import {sha,stable} from '../../private-equity/src/evidence-execution/store';
import {prepareEconomicDevelopmentCheckTx,currentEconomicDevelopmentCheckTx,storedEconomicCapsuleTx} from '../../private-equity/src/economic-orchestration/capsules';
import {append} from '../../private-equity/src/compute-search/store';
/** Actual S8 additive check-only domain. Never admitted, active, protected or an effect origin. */
export async function issueEconomicOrchestrationDevelopmentCheckTx(ctx:PeMutationContext,s:SearchRow,q:ProgramRow,digest:string,c:PoolClient){
 const check=await prepareEconomicDevelopmentCheckTx(ctx,s,q,digest,c);
 await append(ctx,s,'W1_BOUNDARY_CURRENTNESS_CHECKED',{boundary:'CHECK',checkerScope:'ACTUAL_S8_INDEPENDENT_POLICY_CHECK',
  candidateDigest:digest,materialDigest:check.materialDigest,originalEpisode:q.episode_id,authorityGranted:false},c);
 await c.query(`INSERT INTO finnor_os.w1_development_checks(tenant_id,principal_id,search_id,candidate_digest,body,digest)
  VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(tenant_id,principal_id,search_id,candidate_digest) DO NOTHING`,
  [s.tenant_id,s.principal_id,s.id,digest,stable(check),sha(check)]);
 const capsule=await storedEconomicCapsuleTx(s,digest,c),current=await currentEconomicDevelopmentCheckTx(ctx,s,capsule,c);
 if(sha(current)!==sha(check))throw Error('W1_S8_TYPED_DEVELOPMENT_PREIMAGE_CONFLICT');
 return current;
}
