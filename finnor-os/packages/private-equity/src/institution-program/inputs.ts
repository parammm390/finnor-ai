import { z } from 'zod';
import { evaluateAuthority } from '@finnor/authority';
import { loadDocumentVersion } from '@finnor/data-platform';
import { withTenantTransaction } from '@finnor/db';
import type { PeMutationContext } from '../types';
import { authorizeBeliefResources } from '../enterprise-beliefs';
import { originalRawRecords } from './checker-raw';
import { INSTITUTION_COMPLETION_CONTRACTS } from './completion-contracts';
import { authorizeInstitutionWork,loadInstitutionProfile } from './store';
import { stable,tx } from '../evidence-execution/store';

const instant=z.string().datetime({precision:3}).refine(value=>new Date(value).toISOString()===value);
const label=z.string().trim().min(1).max(160);
const rule=z.object({id:label,triggerKind:label,operation:label,principalId:z.string().uuid(),
  deadlineAt:instant,materiality:z.string().min(1).max(2000)}).passthrough()
  .refine(value=>!['postconditionRef','observerRef','actionPayload','expectedEntityId','postconditionDigest'].some(field=>Object.hasOwn(value,field)),
    'Completion observers are registered by the owner');
export const institutionMandateInput=z.object({workId:z.string().uuid(),institutionId:label,
  rules:z.array(rule).min(1).max(128),expiresAt:instant}).strict()
  .refine(value=>Buffer.byteLength(stable(value.rules))<=131072&&new Set(value.rules.map(r=>r.id)).size===value.rules.length);
export const institutionSourceInput=z.object({workId:z.string().uuid(),documentId:z.string().uuid(),
  documentVersionId:z.string().uuid(),sourceClass:label,protocol:label,purpose:z.string().trim().min(1).max(2000),
  expiresAt:instant}).strict();

async function inputDecision(ctx:PeMutationContext,workId:string,documentId?:string){
  await authorizeInstitutionWork(ctx,workId);
  const decision=await evaluateAuthority(ctx.auth,{operation:'query',capability:'query:pe_world_state',risk:'low',
    workId,resources:[{type:'work',id:workId},...(documentId?[{type:'document',id:documentId}]:[])]});
  if(decision.outcome!=='allowed'||decision.reasonCode!=='grant_allows')throw Error('X1_CURRENT_INPUT_READ_AUTHORITY_REQUIRED');
  return decision.id;
}

/** Standing rules are business inputs. Completion meanings come from the native
 * closed registry; unsupported fields remain available to the compiler as gaps. */
export async function configureInstitutionMandate(ctx:PeMutationContext,body:unknown){
  const input=institutionMandateInput.parse(body),decisionId=await inputDecision(ctx,input.workId);
  if(Date.parse(input.expiresAt)<=Date.now())throw Error('X1_INPUT_EXPIRY_REQUIRED');
  const rules=input.rules.map(supplied=>{
    const completion=INSTITUTION_COMPLETION_CONTRACTS[supplied.operation as keyof typeof INSTITUTION_COMPLETION_CONTRACTS];
    return {...supplied,postconditionRef:completion?.postconditionRef??'unsupported:'+supplied.operation,
      observerRef:completion?.observerRef??'unsupported:'+supplied.operation};
  });
  return tx(ctx,async c=>(await c.query(`SELECT * FROM finnor_os.x1_configure_work_mandate($1,$2,$3::jsonb,$4,$5)`,
    [input.workId,input.institutionId,stable(rules),input.expiresAt,decisionId])).rows[0]);
}

/** This only narrows an existing current read right to an owned Core original.
 * The firm declares transport class/protocol, never a canonical mapping. */
export async function registerInstitutionCoreSource(ctx:PeMutationContext,body:unknown){
  const input=institutionSourceInput.parse(body),profile=loadInstitutionProfile();
  if(!profile.sourceClasses.some(c=>c.id===input.sourceClass&&c.protocols.includes(input.protocol)))
    throw Error('X1_INPUT_PROTOCOL_OUTSIDE_DECLARED_PROFILE');
  await inputDecision(ctx,input.workId,input.documentId);
  const acquired=await withTenantTransaction(ctx.auth.tenantId,{userId:ctx.auth.userId,readOnly:true},async(db,c)=>{
    const owned=(await c.query(`SELECT d.id FROM finnor_os.documents d JOIN finnor_os.document_versions v
      ON v.tenant_id=d.tenant_id AND v.document_id=d.id WHERE d.tenant_id=$1 AND d.id=$2 AND v.id=$3
      AND d.created_by=$4 AND v.created_by=$4`,[ctx.auth.tenantId,input.documentId,input.documentVersionId,ctx.auth.userId])).rows[0];
    if(!owned)throw Error('X1_INPUT_OWNED_CORE_ORIGINAL_REQUIRED');
    return loadDocumentVersion(db,ctx.auth.tenantId,input.documentId,input.documentVersionId);
  });
  if(!acquired||!acquired.bytes.length||acquired.bytes.length>profile.bounds.objectBytes)
    throw Error('X1_INPUT_ORIGINAL_BYTE_BOUND');
  const binary=['pdf_text','docx','xlsx'].includes(input.protocol);
  const records=await originalRawRecords({sourceClass:input.sourceClass,protocol:input.protocol,
    rawUtf8:binary?'':new TextDecoder('utf-8',{fatal:true}).decode(acquired.bytes),
    ...(binary?{rawBase64:acquired.bytes.toString('base64')}:{})},profile.bounds.tabularRowsPerObject,profile.bounds.objectBytes);
  const expected=records.map(r=>r.id);
  if(!expected.length||new Set(expected).size!==expected.length)throw Error('X1_INPUT_ORIGINAL_OBJECT_IDENTITY_REQUIRED');
  const sensitive=['personnel_benefits','expense_administration'].includes(input.sourceClass);
  if(sensitive&&records.some(r=>!r.registrationId))throw Error('X1_COMPLETE_SENSITIVE_SUBJECT_CERTIFICATION_REQUIRED');
  const subjects=sensitive?[...new Set(records.map(r=>r.registrationId!))].sort():[];
  if(subjects.length>profile.bounds.people)throw Error('X1_SENSITIVE_SUBJECT_BOUND');
  // Parsing can be expensive. Obtain the current decision after it and let the
  // SQL owner lock the exact revision and immutable version before publication.
  const decisionId=await inputDecision(ctx,input.workId,input.documentId);
  return tx(ctx,async c=>(await c.query(`SELECT * FROM finnor_os.x1_register_owned_core_source_v2($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`,
    [input.workId,input.documentId,input.documentVersionId,input.sourceClass,input.protocol,input.purpose,
      acquired.version.byte_sha256,stable(expected),stable(subjects),input.expiresAt,decisionId])).rows[0]);
}

export async function readInstitutionInputs(ctx:PeMutationContext,workId:string){
  await authorizeInstitutionWork(ctx,workId);
  await authorizeBeliefResources(ctx,[{type:'tenant',id:ctx.auth.tenantId}]);
  const profile=loadInstitutionProfile();
  return tx(ctx,async c=>({workId,principalId:ctx.auth.userId,profile:{id:profile.id,sourceClasses:profile.sourceClasses,
    ordinaryOperations:profile.ordinaryOperations},
    mandate:(await c.query(`SELECT id::text,standing_id::text,institution_id,revision,rules,expires_at
      FROM finnor_os.x1_work_mandates WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3
      AND revoked_at IS NULL AND valid_from<=clock_timestamp() AND expires_at>clock_timestamp()
      ORDER BY created_at DESC,id DESC LIMIT 1`,[ctx.auth.tenantId,ctx.auth.userId,workId])).rows[0]??null,
    documents:(await c.query(`SELECT DISTINCT ON(d.id) d.id::text document_id,d.title,d.external_id,
      v.id::text version_id,v.media_type,v.size_bytes FROM finnor_os.documents d
      JOIN finnor_os.document_versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id
      WHERE d.tenant_id=$1 AND d.created_by=$2 AND v.created_by=$2
      ORDER BY d.id,v.version_ordinal DESC LIMIT 100`,[ctx.auth.tenantId,ctx.auth.userId])).rows,
    principals:(await c.query(`SELECT id::text,display_name FROM finnor_os.users
      WHERE tenant_id=$1 AND status='active' ORDER BY id LIMIT 200`,[ctx.auth.tenantId])).rows,
  }),true);
}

export const institutionSelfConsentInput=z.object({institutionId:label,
  sourceClass:z.enum(['personnel_benefits','expense_administration']),purpose:z.string().trim().min(1).max(2000),
  expiresAt:instant.optional(),revoke:z.boolean().default(false)}).strict();
export async function setInstitutionSelfConsent(ctx:PeMutationContext,body:unknown){
  const input=institutionSelfConsentInput.parse(body);
  if(!input.revoke&&(!input.expiresAt||Date.parse(input.expiresAt)<=Date.now()))throw Error('X1_INPUT_EXPIRY_REQUIRED');
  return tx(ctx,async c=>(await c.query(`SELECT * FROM finnor_os.x1_set_subject_consent($1,$2,$3,$4,$5)`,
    [input.institutionId,input.sourceClass,input.purpose,input.expiresAt??null,input.revoke])).rows[0]);
}
