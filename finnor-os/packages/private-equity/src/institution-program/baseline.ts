import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PeMutationContext } from '../types';
import { tx,sha,schemaIdentity,principal } from '../evidence-execution/store';
import type { OriginalInstitutionEvidence } from './checker';
import type { DigitalInstitutionProfile } from './contracts';
import { installedDevelopmentRuntime } from './installed-runtime';

const root=fileURLToPath(new URL('../../../../../',import.meta.url));
/** Observed installation identity, not predecessor qualification or promotion.
 * Preimages live in the existing immutable artifact's input_manifest. */
export async function observedInstitutionBaseline(ctx:PeMutationContext,input:{
  compilerId:string;workInputId:string;episodeId:string;original:OriginalInstitutionEvidence;
  profile:DigitalInstitutionProfile;producer:{digest:string;files:unknown[];node:string};
  parentReservation:{owner:string;id:string;version:string;contentDigest:string};
}){
  let gitCut:unknown;
  try{
    const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:5000,maxBuffer:67108864}).trim();
    gitCut={status:'OBSERVED',commit:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),
      dirty:git('status','--porcelain=v1','-uall'),dirtyDiffDigest:sha(git('diff','--binary'))};
  }catch{gitCut={status:'UNKNOWN',reason:'Git source history is unavailable in this installed runtime; loaded source bytes are recorded'};}
  const bytes=await Promise.all([
    readFile(new URL('../../../../../package-lock.json',import.meta.url)),
    readFile(new URL('../../../../package-lock.json',import.meta.url)),readFile(process.execPath),
  ]);
  const owner=await tx(ctx,async c=>({
    migrations:(await c.query('SELECT name FROM finnor_os._migrations ORDER BY name')).rows.map(row=>row.name),
    grants:(await c.query(`SELECT g.id::text,g.source_id,g.source_class,g.protocol,g.revision,g.version,
      g.document_id::text,g.document_version_id::text,g.original_sha256,g.valid_from,g.expires_at,g.revoked_at
      FROM finnor_os.x1_source_grants g JOIN finnor_os.x1_compiler_requests q
        ON q.tenant_id=g.tenant_id AND q.principal_id=g.principal_id AND q.work_id=g.work_id
      WHERE q.tenant_id=$1 AND q.principal_id=$2 AND q.id=$3 AND q.grant_ids ? g.id::text ORDER BY g.source_id`,
    [ctx.auth.tenantId,principal(ctx),input.compilerId])).rows,
  }),true);
  if(owner.grants.length!==input.original.sources.length||owner.migrations.at(-1)!==input.original.current.schemaRevision)
    throw Error('X1_OBSERVED_BASELINE_OWNER_POPULATION_CHANGED');
  const body={schema:'finnor.x1.observed-baseline.v1',classification:'B_live',
    tenantId:ctx.auth.tenantId,principalId:principal(ctx),workId:input.original.workId,
    workInputId:input.workInputId,compilerId:input.compilerId,originalEpisodeId:input.episodeId,
    source:{git:gitCut,loaded:input.producer,installation:(()=>{const i=installedDevelopmentRuntime();
      return i?{manifestDigest:i.manifestDigest,source:i.manifest.source,
        kind:'OBSERVED_COMPILED_DEVELOPMENT_INSTALLATION',gitHistoryAvailable:false}:null;})()},
    runtime:{node:process.version,platform:process.platform,architecture:process.arch,executableDigest:sha(bytes[2]!),
      runtimeRevision:input.original.current.runtimeRevision},
    dependencies:{rootLockDigest:sha(bytes[0]!),backendLockDigest:sha(bytes[1]!)},
    schemaState:{head:input.original.current.schemaRevision,migrations:owner.migrations,catalogDigest:await schemaIdentity(ctx)},
    profile:{id:input.profile.id,revision:input.profile.revision,digest:sha(input.profile)},
    current:input.original.current,mandate:input.original.mandate,sourceGrantPins:owner.grants.map(g=>({...g,
      valid_from:new Date(g.valid_from).toISOString(),expires_at:new Date(g.expires_at).toISOString(),
      revoked_at:g.revoked_at?new Date(g.revoked_at).toISOString():null})),
    originalParentReservation:input.parentReservation,
    enabledCapabilities:{ordinaryOperations:input.original.current.authorizedOperations,
      compilerMethodRevision:input.original.current.methodRevision,protectedOperationAuthority:'UNESTABLISHED'},
    qualification:{B_V:'MISSING_INDEPENDENTLY_QUALIFIED_PREDECESSOR_RECEIPTS',B_ref:'SEPARATE_MATCHED_DIAGNOSTIC_REQUIRED',
      compilerModel:'DETERMINISTIC_NATIVE_COMPILER_NO_LLM_MAPPING_CALL',otherModelProviderCoverage:'UNKNOWN_OUTSIDE_RECORDED_EPISODE',
      hostedAuthQualification:'NOT_ESTABLISHED_BY_LOCAL_AUTH_SERVICE',
      preparationCosts:'PARTIAL_RECORDED_NATIVE_COMPUTE_OTHER_COSTS_UNKNOWN',
      domainQualification:'UNESTABLISHED',executionAuthorityGranted:false},
  };
  return {body,digest:sha(body)};
}
