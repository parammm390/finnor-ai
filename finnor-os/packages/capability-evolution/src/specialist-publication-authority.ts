/** Authenticated S8 canonical boundary. Never a current:true SQL materializer. */
import pg, { type PoolClient } from "pg";
import { checkServerIdentity } from "node:tls";
import { z } from "zod";
import { privateFile } from "./journal";
import { digest, byteDigest, fault, RefSchema, type CapabilityRef } from "./contracts";
import { canonical } from "../../governed-execution/src/protocol";
import { pgConnectionConfig } from "../../db/postgres-connection.mjs";
import { readOwnerTransportReference } from "../../governed-execution/src/owner-transport";
import { assertVerifiedEnrollment, assertCurrentEnrollment, candidateSchema, observationSchema, immutable, integer, primarySchema, type VerifiedEnrollment } from "./specialist-publication-protocol";

const text=z.string().min(1).max(4096),hex=z.string().regex(/^[a-f0-9]{64}$/);
const role=z.enum(["adapter","candidate","proof","projection","reader"]);
const configuration=z.object({
  schema:z.literal("finnor.specialist.canonical-database-client.v1"),
  enrollmentDigest:hex,role,processUid:z.number().int().nonnegative(),
  secretPath:text,tlsCertificateSha256:hex,witnessDirectory:text,
  connectionTimeoutMs:z.number().int().min(100).max(5000),
}).strict();
export type CanonicalClientConfiguration=z.infer<typeof configuration>;
export const historySchema=z.object({
  policyDigest:hex,sequence:z.number().int().nonnegative(),historyDigest:hex,
  previousHistoryDigest:hex,s6PrefixDigest:hex,holdsDigest:hex,protectedWitnessDigest:hex,
  canonicalStateDigest:hex,entryDigests:z.array(hex).max(100000),
  acceptedReferences:z.array(RefSchema).max(100000),protectedEventsDigest:hex,
}).strict();
export type CanonicalHistory=z.infer<typeof historySchema>;
export const originalAuthorityCustodySchema=z.object({
  schema:z.literal("finnor.specialist.readonly-original-s8-custody.v1"),
  enrollmentDigest:hex,epoch:integer,historyDigest:hex,history:historySchema,primary:primarySchema,
  status:z.enum(["ACTIVE","PENDING"]),pendingId:text.nullable(),pendingOriginalDigest:hex.nullable(),
}).strict();
export type OriginalAuthorityCustody=z.infer<typeof originalAuthorityCustodySchema>;
const qualification=z.object({
  schema:z.literal("finnor.specialist.actual-canonical-deployment-qualification.v1"),
  enrollmentScopeDigest:hex,participatingCodeDigest:hex,sourceClosureDigest:hex,runtimeDigest:hex,
  sqlDefinitionDigest:hex,sqlAclDigest:hex,primary:primarySchema,
  requiredOriginIds:z.array(text).min(7).max(64),
  installedSourcePins:z.array(z.object({path:text,sha256:hex}).strict()).min(1).max(1024),
  witnessQualificationRefs:z.array(RefSchema).min(7).max(64),
  readerWriterClosureRef:RefSchema,sqlPrivilegesRef:RefSchema,
  clientBindings:z.record(text,z.object({processUid:z.number().int().nonnegative(),
    tlsCertificateSha256:hex,witnessDirectory:text}).strict()),
}).strict();
export { qualification as canonicalDeploymentQualificationSchema };
export const nativeSpecialistDefinerSignatures = [
  "finnor_os.append_pe_business_event()",
  "finnor_os.append_product_truth_operational_delta()",
  "finnor_os.bump_authority_revision()",
  "finnor_os.pe_v3_record_closed_certificate()",
  "finnor_os.sync_artifact_owner_authority()",
  "finnor_os.sync_ic_owner_authority()",
  "finnor_os.sync_role_permission_authority()",
  "finnor_os.sync_user_legacy_authority()",
  "finnor_os.sync_workforce_owner_authority()",
] as const;
const nativeFence=new WeakSet<object>();
export interface CanonicalEpoch{
  readonly enrollmentDigest:string;readonly epoch:string;readonly historyDigest:string;
  readonly canonicalState:unknown;readonly history:CanonicalHistory;
}
const mutationHandles=new WeakMap<object,{client:CanonicalSpecialistAuthority;id:string;
  originalDigest:string;epoch:string;prior:string}>();
export interface CanonicalMutation{readonly id:string;readonly epoch:string;readonly created:boolean}
export class CanonicalSpecialistAuthority{
  private constructor(readonly enrollment:VerifiedEnrollment,private pool:pg.Pool,
    readonly config:CanonicalClientConfiguration){}
  static async open(enrollment:VerifiedEnrollment,raw:unknown,installed:{
    sourceClosureDigest:string;runtimeDigest:string;sources:readonly {path:string;sha256:string}[];
  }){
    assertVerifiedEnrollment(enrollment);
    const config=configuration.parse(raw),e=enrollment.body;
    if(config.enrollmentDigest!==enrollment.digest||process.getuid?.()!==config.processUid
      ||e.sourceClosureDigest!==installed.sourceClosureDigest||e.runtimeDigest!==installed.runtimeDigest)
      fault("SPECIALIST_CANONICAL_RUNTIME_IDENTITY_UNADMITTED",503);
    const found=await readOwnerTransportReference({semanticOwner:"S8",tenantId:e.tenantId,
      principalId:e.principalId},e.qualifiedDeploymentRef.id);
    const q=qualification.parse(found.reference.content),
      {qualifiedDeploymentRef:_qualification,...enrollmentScope}=e,
      client=q.clientBindings[config.role];
    if(!found.receipt||digest(found.reference.content)!==e.qualifiedDeploymentRef.contentDigest
      ||digest(q.installedSourcePins)!==digest(installed.sources)
      ||q.enrollmentScopeDigest!==digest(enrollmentScope)||q.participatingCodeDigest!==e.participatingCodeDigest
      ||q.sourceClosureDigest!==e.sourceClosureDigest||q.runtimeDigest!==e.runtimeDigest
      ||q.sqlDefinitionDigest!==e.sqlDefinitionDigest||q.sqlAclDigest!==e.sqlAclDigest
      ||digest(q.primary)!==digest(e.primary)
      ||digest([...q.requiredOriginIds].sort())!==digest(e.origins.map(o=>o.id).sort())
      ||!client||client.processUid!==config.processUid||client.tlsCertificateSha256!==config.tlsCertificateSha256
      ||client.witnessDirectory!==config.witnessDirectory)
      fault("SPECIALIST_ACTUAL_QUALIFIED_WRITER_READER_CLOSURE_REQUIRED",503);
    for(const ref of [...q.witnessQualificationRefs,q.readerWriterClosureRef,q.sqlPrivilegesRef]){
      const result=await readOwnerTransportReference({semanticOwner:"S8",tenantId:e.tenantId,
        principalId:e.principalId},ref.id);
      if(!result.receipt||digest(result.reference.content)!==ref.contentDigest)
        fault("SPECIALIST_ACTUAL_QUALIFICATION_REFERENCE_UNAVAILABLE",503);
    }
    const secret=z.object({connectionString:text}).strict()
      .parse(JSON.parse((await privateFile(config.secretPath,16384)).toString()));
    const parsed=pgConnectionConfig(secret.connectionString);
    if(!parsed.ssl||typeof parsed.ssl!=="object"||parsed.ssl.rejectUnauthorized===false)
      fault("SPECIALIST_AUTHENTICATED_PRIMARY_TLS_REQUIRED",503);
    const pool=new pg.Pool({...parsed,max:2,connectionTimeoutMillis:config.connectionTimeoutMs,
      statement_timeout:5000,idle_in_transaction_session_timeout:5000,
      ssl:{...parsed.ssl,rejectUnauthorized:true,checkServerIdentity(host,cert){
        const error=checkServerIdentity(host,cert);
        if(error)return error;
        if(byteDigest(cert.raw)!==config.tlsCertificateSha256)return Error("SPECIALIST_PRIMARY_TLS_PIN_CHANGED");
      }}});
    const value=new CanonicalSpecialistAuthority(enrollment,pool,immutable(config));
    try{await value.assertDatabaseCustody();return value;}catch(error){await pool.end();throw error;}
  }
  private args(){return[this.enrollment.body.tenantId,this.enrollment.body.principalId];}
  async assertDatabaseCustody(){
    const login=(await this.pool.query(`SELECT session_user AS login,current_user AS effective_role,r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,
      r.rolreplication,r.rolbypassrls,pg_has_role(session_user,'finnor_specialist_owner','MEMBER') owner_member,
      has_schema_privilege(session_user,'finnor_specialist','CREATE') schema_create,
      has_schema_privilege(session_user,'finnor_os','CREATE') source_schema_create,
      (pg_has_role(session_user,'finnor_app','MEMBER') OR pg_has_role(session_user,'finnor_worker','MEMBER')) application_member
      FROM pg_roles r WHERE r.rolname=session_user`)).rows[0];
    if(!login||!login.rolcanlogin||login.effective_role!==login.login||login.application_member
      ||login.login!==this.enrollment.body.roles[this.config.role]||login.rolsuper||login.rolcreatedb
      ||login.rolcreaterole||login.rolreplication||login.rolbypassrls||login.owner_member||login.schema_create||login.source_schema_create)
      fault("SPECIALIST_DATABASE_ROLE_BOUNDARY_UNADMITTED",503);
    const tableAcls=(await this.pool.query(`SELECT c.relname,
      has_table_privilege(session_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') writable
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='finnor_specialist' AND c.relkind IN('r','p') ORDER BY c.relname`)).rows;
    if(!tableAcls.length||tableAcls.some(r=>r.writable))fault("SPECIALIST_DIRECT_AUTHORITY_WRITE_BYPASS",503);
    const definitions=(await this.pool.query(`SELECT p.proname,pg_get_functiondef(p.oid) definition,
      p.prosecdef,r.rolname owner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='finnor_specialist' ORDER BY p.proname,p.oid`)).rows;
    const nativeDefinitions=(await this.pool.query(`SELECT p.proname,
      pg_get_function_identity_arguments(p.oid) arguments,pg_get_functiondef(p.oid) definition,
      p.prosecdef,r.rolname owner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='finnor_os' AND p.prokind IN('f','p')
      ORDER BY p.proname,arguments`)).rows;
    if(nativeDefinitions.length>2048||Buffer.byteLength(JSON.stringify(nativeDefinitions))>16*1024*1024)
      fault("SPECIALIST_NATIVE_FUNCTION_CUSTODY_BOUND_EXCEEDED",503);
    const constraints=(await this.pool.query(`SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) definition
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='finnor_specialist' ORDER BY c.relname,k.conname`)).rows;
    const triggers=(await this.pool.query(`SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) definition,t.tgenabled
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE NOT t.tgisinternal AND (n.nspname='finnor_specialist'
        OR n.nspname='finnor_os' AND EXISTS(SELECT 1 FROM pg_policy p
          WHERE p.polrelid=c.oid AND p.polname='specialist_source_scope'))
      ORDER BY c.relname,t.tgname`)).rows;
    const acls=(await this.pool.query(`SELECT n.nspname,c.relname,c.relacl::text,r.rolname owner
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
      WHERE n.nspname='finnor_specialist' ORDER BY c.relname`)).rows;
    const memberships=(await this.pool.query(`SELECT a.rolname role,m.rolname member,x.admin_option
      FROM pg_auth_members x JOIN pg_roles a ON a.oid=x.roleid JOIN pg_roles m ON m.oid=x.member
      WHERE a.rolname LIKE 'finnor_specialist_%' OR m.rolname=ANY($1::text[])
      ORDER BY a.rolname,m.rolname`,[Object.values(this.enrollment.body.roles)])).rows;
    const sourceAcls=(await this.pool.query(`SELECT n.nspname,c.relname,c.relacl::text,c.relrowsecurity,
      c.relforcerowsecurity,r.rolname owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='finnor_os'
      AND EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='specialist_source_scope')
      ORDER BY c.relname`)).rows;
    const sourcePolicies=(await this.pool.query(`SELECT c.relname,p.polname,p.polpermissive,p.polcmd,
      ARRAY(SELECT r.rolname FROM pg_roles r WHERE r.oid=ANY(p.polroles) ORDER BY r.rolname) roles,
      pg_get_expr(p.polqual,p.polrelid) using_expression,pg_get_expr(p.polwithcheck,p.polrelid) check_expression
      FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='finnor_os' AND EXISTS(SELECT 1 FROM pg_policy guard
        WHERE guard.polrelid=c.oid AND guard.polname='specialist_source_scope') ORDER BY c.relname,p.polname`)).rows;
    const nativeAclCustody=(await this.pool.query(
      "SELECT finnor_specialist.read_native_acl_custody() value")).rows[0]?.value;
    if(!Array.isArray(nativeAclCustody)||nativeAclCustody.length!==nativeSpecialistDefinerSignatures.length
      ||nativeSpecialistDefinerSignatures.some((signature,index)=>nativeAclCustody[index]?.signature!==signature))
      fault("SPECIALIST_NATIVE_ACL_CUSTODY_UNAVAILABLE",503);
    const functionAcls=(await this.pool.query(`SELECT n.nspname,p.proname,
      pg_get_function_identity_arguments(p.oid) arguments,p.proacl::text,r.rolname owner,p.prosecdef
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
      WHERE n.nspname IN('finnor_specialist','finnor_os') ORDER BY n.nspname,p.proname,arguments`)).rows;
    const roleAttributes=(await this.pool.query(`SELECT rolname,rolcanlogin,rolsuper,rolinherit,rolcreatedb,
      rolcreaterole,rolreplication,rolbypassrls,rolconfig,rolvaliduntil::text FROM pg_roles
      WHERE rolname=ANY($1::text[]) OR rolname LIKE 'finnor_specialist_%' ORDER BY rolname`,
      [Object.values(this.enrollment.body.roles)])).rows;
    if(this.config.role==="candidate"){
      const pendingPort=(await this.pool.query(
        "SELECT has_function_privilege(session_user,'finnor_specialist.native_pending(uuid,uuid)','EXECUTE') present"
      )).rows[0]?.present===true;
      if(!pendingPort)fault("SPECIALIST_EXACT_NATIVE_PENDING_LOADER_PRIVILEGE_REQUIRED",503);
      const unexpectedMembership=(await this.pool.query(`SELECT rolname FROM pg_roles
        WHERE rolname<>session_user AND rolname<>'finnor_specialist_candidate'
          AND pg_has_role(session_user,oid,'MEMBER')`)).rows;
      const candidateMember=(await this.pool.query(
        "SELECT pg_has_role(session_user,'finnor_specialist_candidate','MEMBER') member")).rows[0]?.member===true;
      const lockSources=["users","works","work_inputs","jobs","w2_programs","authority_states","employee_actor_profiles",
        "delegations","employee_role_assignments","external_contacts","w2_contact_bindings","s5_reservations"];
      const sourceColumns=(await this.pool.query(`SELECT c.relname,a.attname,
        has_column_privilege(session_user,c.oid,a.attnum,'INSERT,REFERENCES') unsafe,
        has_column_privilege(session_user,c.oid,a.attnum,'UPDATE') mutable
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='finnor_os' AND c.relkind IN('r','p') AND a.attnum>0 AND NOT a.attisdropped
        ORDER BY c.relname,a.attnum`)).rows;
      const sourcePrivileges=(await this.pool.query(`SELECT c.relname,
        has_table_privilege(session_user,c.oid,'INSERT,DELETE,TRUNCATE,TRIGGER') unsafe,
        pg_has_role(session_user,c.relowner,'MEMBER') owner_member,c.relrowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='finnor_os' AND c.relkind IN('r','p') ORDER BY c.relname`)).rows;
      // PUBLIC EXECUTE cannot be denied per role. Refuse any existing definer
      // escape rather than assuming column grants/RLS neutralize it.
      const callableDefiners=(await this.pool.query(`SELECT n.nspname,p.proname,
        pg_get_function_identity_arguments(p.oid) arguments,
        n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')' signature FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND p.prosecdef
          AND has_function_privilege(session_user,p.oid,'EXECUTE') ORDER BY n.nspname,p.proname,arguments`)).rows;
      const allowedDefiners=new Set([
        "finnor_specialist.primary_identity()",
        "finnor_specialist.read_native_acl_custody()",
        "finnor_specialist.read_domain(uuid,uuid)",
        "finnor_specialist.open_candidate_scope(uuid,uuid,uuid,text,uuid,bigint,text)",
        "finnor_specialist.candidate_source_scope(uuid)",
        "finnor_specialist.candidate_source_row(uuid,text,text)",
        "finnor_specialist.reserve_original(uuid,uuid,text,jsonb,text,xid8,integer,timestampwithtimezone)",
        "finnor_specialist.insert_candidate(uuid,uuid,jsonb,text,jsonb,jsonb)",
        "finnor_specialist.capture_original_upper(uuid,uuid,text)",
        "finnor_specialist.observe_original(uuid,uuid,text)",
        "finnor_specialist.native_pending(uuid,uuid)",
        "finnor_os.w2_actor_occupation(uuid[],uuid)",
        "finnor_os.y4_allocation_context_complete()",
        "finnor_os.s5_institution_outstanding()",
        "finnor_os.y4_s5_private(uuid,text)",
        "finnor_os.y4_s5_subject_visible(uuid,text)",
        "finnor_os.y4_s5_visible(uuid,text)", "finnor_os.y4_s5_experience_visible(uuid,uuid,jsonb)",
        "finnor_os.y4_s6_effect_visible(uuid,uuid)", "finnor_os.s5_institution_visible(text)",
        "finnor_os.s5_institution_consumption_visible(text)",
        "finnor_os.v4_evidence_permitted(uuid)", "finnor_os.v4_action_permitted(uuid)",
      ]);      if(!candidateMember || unexpectedMembership.length || !sourceAcls.length
        || sourceColumns.some(row=>row.unsafe||(row.mutable
          &&(row.attname!=="tenant_id"||!lockSources.includes(row.relname))))
        || sourcePrivileges.some(row=>row.unsafe||row.owner_member)
        || sourceAcls.some(row=>!row.relrowsecurity||row.owner===login.login)
        || callableDefiners.some(row=>!allowedDefiners.has(row.signature.replace(/\s+/g,""))))
        fault("SPECIALIST_CANDIDATE_SOURCE_PRIVILEGE_OR_DEFINER_ESCAPE",503);
    }
    if(definitions.some(d=>d.owner!=="finnor_specialist_owner")
      ||triggers.some(t=>t.tgenabled!=="O")
      ||digest({definitions,nativeDefinitions,constraints,triggers,nativeAclCustody})!==this.enrollment.body.sqlDefinitionDigest
      ||digest({acls,memberships,sourceAcls,sourcePolicies,functionAcls,roleAttributes,nativeAclCustody})!==this.enrollment.body.sqlAclDigest)
      fault("SPECIALIST_ACTUAL_SCHEMA_FUNCTION_ACL_IDENTITY_CHANGED",503);
    for(const other of ["adapter","candidate","proof","projection","reader"]as const){
      if(other===this.config.role)continue;
      const membership=(await this.pool.query("SELECT pg_has_role(session_user,$1,'MEMBER') present",
        [this.enrollment.body.roles[other]])).rows[0];
      if(membership?.present)fault("SPECIALIST_SQL_ROLES_NOT_SEPARATED",503);
    }
    const primary=(await this.pool.query("SELECT finnor_specialist.primary_identity() AS value")).rows[0]?.value;
    if(digest(primary)!==digest(this.enrollment.body.primary))fault("SPECIALIST_PRIMARY_INCARCATION_CHANGED",503);
  }
  /** Read actual original custody, not fresh-use admission or a current:true grant. */
  async readOriginalAuthorityCustody():Promise<OriginalAuthorityCustody>{
    assertVerifiedEnrollment(this.enrollment);
    const row=(await this.pool.query("SELECT finnor_specialist.read_domain($1,$2) value",this.args())).rows[0]?.value,
      d=row?.domain,history=historySchema.parse(d?.history_evidence);
    if(!d||d.enrollment_digest!==this.enrollment.digest||digest(row.enrollment)!==this.enrollment.digest
      ||digest(row.primary)!==digest(this.enrollment.body.primary)||history.historyDigest!==d.history_digest
      ||history.policyDigest!==this.enrollment.body.policyDigest
      ||d.status==="ACTIVE"&&(d.pending_id!==null||row.pendingOriginal!==null)
      ||d.status==="PENDING"&&(!d.pending_id||row.pendingOriginal==null))
      fault("SPECIALIST_ORIGINAL_S8_CUSTODY_UNAVAILABLE",503);
    return immutable(originalAuthorityCustodySchema.parse({
      schema:"finnor.specialist.readonly-original-s8-custody.v1",enrollmentDigest:d.enrollment_digest,
      epoch:String(d.epoch),historyDigest:d.history_digest,history,primary:row.primary,status:d.status,
      pendingId:d.pending_id,pendingOriginalDigest:row.pendingOriginal==null?null:digest(row.pendingOriginal),
    }));
  }
  async readEpoch(actualHistory?:CanonicalHistory):Promise<CanonicalEpoch>{
    const row=(await this.pool.query("SELECT finnor_specialist.read_domain($1,$2) value",this.args())).rows[0]?.value,
      d=row?.domain;
    if(!d||d.status!=="ACTIVE"||d.enrollment_digest!==this.enrollment.digest
      ||digest(row.primary)!==digest(this.enrollment.body.primary))
      fault("SPECIALIST_CANONICAL_HISTORY_PENDING_OR_UNAVAILABLE",503);
    const history=historySchema.parse(d.history_evidence);
    if(actualHistory&&digest(history)!==digest(actualHistory))
      fault("SPECIALIST_FS_S6_CANONICAL_HISTORY_DISAGREEMENT",503);
    const value=immutable({enrollmentDigest:this.enrollment.digest,epoch:String(d.epoch),
      historyDigest:d.history_digest,canonicalState:d.canonical_state,history});
    nativeFence.add(value);return value;
  }
  async enroll(history:CanonicalHistory,state:unknown,evidence:unknown){
    if(this.config.role!=="adapter")fault("SPECIALIST_ADAPTER_ROLE_REQUIRED",403);
    assertCurrentEnrollment(this.enrollment);
    historySchema.parse(history);
    if(history.canonicalStateDigest!==digest(state)||history.policyDigest!==this.enrollment.body.policyDigest)
      fault("SPECIALIST_AUTHENTICATED_ORIGINAL_HISTORY_REQUIRED",503);
    await this.pool.query("SELECT finnor_specialist.enroll($1,$2,$3,$4,$5)",
      [this.enrollment.body,JSON.stringify(evidence),JSON.stringify(state),history,this.enrollment.digest]);
  }
  async begin(original:unknown,prior:CanonicalHistory,holds:Array<{commitment:string;originalOwnerDigest:string}>)
    :Promise<CanonicalMutation>{
    if(this.config.role!=="adapter")fault("SPECIALIST_ADAPTER_ROLE_REQUIRED",403);
    assertCurrentEnrollment(this.enrollment);
    const id=digest({enrollmentDigest:this.enrollment.digest,original}),originalDigest=digest(original),
      row=(await this.pool.query("SELECT finnor_specialist.begin_transition($1,$2,$3,$4,$5,$6,$7) value",
        [...this.args(),id,JSON.stringify(original),originalDigest,prior.historyDigest,JSON.stringify(holds)])).rows[0]?.value;
    if(!row||row.id!==id)fault("SPECIALIST_CANONICAL_ORIGINAL_INTENT_UNAVAILABLE",503);
    const value=immutable({id,epoch:String(row.epoch),created:row.created===true});
    mutationHandles.set(value,{client:this,id,originalDigest,epoch:value.epoch,prior:prior.historyDigest});return value;
  }
  async finish(handle:CanonicalMutation,history:CanonicalHistory,state:unknown,evidence:unknown){
    assertCurrentEnrollment(this.enrollment);
    const h=mutationHandles.get(handle);
    if(!h||h.client!==this||history.previousHistoryDigest!==h.prior
      ||history.canonicalStateDigest!==digest(state))fault("SPECIALIST_EXACT_ORIGINAL_CANONICAL_FINALIZATION",503);
    await this.pool.query("SELECT finnor_specialist.finalize_transition($1,$2,$3,$4,$5,$6)",
      [...this.args(),h.id,history,JSON.stringify(state),JSON.stringify({originalDigest:h.originalDigest,evidence})]);
    mutationHandles.delete(handle);
  }
  async startupOriginal(){
    if(this.config.role!=="adapter")fault("SPECIALIST_ADAPTER_ROLE_REQUIRED",403);
    assertCurrentEnrollment(this.enrollment);
    const row=(await this.pool.query("SELECT finnor_specialist.read_domain($1,$2) value",this.args())).rows[0]?.value;
    if(!row?.domain||row.domain.enrollment_digest!==this.enrollment.digest
      ||digest(row.primary)!==digest(this.enrollment.body.primary))
      fault("SPECIALIST_CANONICAL_STARTUP_HISTORY_UNAVAILABLE",503);
    return immutable({history:historySchema.parse(row.domain.history_evidence),
      pendingOriginal:row.pendingOriginal??null,status:row.domain.status,epoch:String(row.domain.epoch)});
  }
  async beforeMutation(handle:CanonicalMutation,step:unknown){
    assertCurrentEnrollment(this.enrollment);
    const h=mutationHandles.get(handle);
    if(!h||h.client!==this)fault("SPECIALIST_CANONICAL_PENDING_MUTATION_REQUIRED",503);
    const created=(await this.pool.query("SELECT finnor_specialist.reserve_transition_step($1,$2,$3,$4,$5) created",
      [...this.args(),h.id,digest(step),JSON.stringify(step)])).rows[0]?.created===true;
    if(!created)fault("SPECIALIST_POSSIBLE_MUTATION_READ_ONLY_RECOVERY_ONLY",503);
  }
  /** Same actual primary connection is exposed only to the authenticated candidate coordinator.
   * It never has adapter/proof/projection privileges. No caller-provided client is accepted. */
  async candidateConnection(){
    if(this.config.role!=="candidate")fault("SPECIALIST_CANDIDATE_ROLE_REQUIRED",403);
    assertCurrentEnrollment(this.enrollment);
    return this.pool.connect();
  }
  async reserveOriginal(candidate:unknown,xid8:string,pid:number,backendStartedAt:string){
    if(this.config.role!=="candidate")fault("SPECIALIST_CANDIDATE_ROLE_REQUIRED",403);
    assertCurrentEnrollment(this.enrollment);
    const b=candidate as {publicationId:string};
    return(await this.pool.query("SELECT finnor_specialist.reserve_original($1,$2,$3,$4,$5,$6::xid8,$7,$8) created",
      [...this.args(),b.publicationId,JSON.stringify(candidate),digest(candidate),xid8,pid,backendStartedAt])).rows[0]?.created===true;
  }
  async observeOriginal(publicationId:string){
    return(await this.pool.query("SELECT finnor_specialist.observe_original($1,$2,$3) value",
      [...this.args(),publicationId])).rows[0]?.value??null;
  }
  async readOriginalAttemptSource(publicationId:string):Promise<unknown>{
    if(this.config.role!=="reader")fault("SPECIALIST_ORIGINAL_SOURCE_ENROLLED_READER_REQUIRED",403);
    assertCurrentEnrollment(this.enrollment);hex.parse(publicationId);
    const original=await this.observeOriginal(publicationId);
    if(!original?.preOriginalSource||original.candidateRow||original.marker)
      fault("SPECIALIST_ORIGINAL_PRE_MODEL_SOURCE_REQUIRED",503);
    return immutable(original.preOriginalSource);
  }
  async listOriginalPublications(afterId:string,maximum:number){
    if(!["proof","projection","reader"].includes(this.config.role))
      fault("SPECIALIST_INDEPENDENT_ORIGINAL_SERVICE_REQUIRED",403);
    if(!Number.isSafeInteger(maximum)||maximum<1||maximum>64
      ||afterId!==""&&!/^[a-f0-9]{64}$/.test(afterId))
      fault("SPECIALIST_ORIGINAL_SERVICE_BOUND_REQUIRED",400);
    const rows=(await this.pool.query("SELECT finnor_specialist.list_original_publications($1,$2,$3,$4) value",
      [...this.args(),afterId,maximum])).rows[0]?.value;
    const ids=z.array(hex).max(maximum).parse(rows);
    if(ids.some((id,i)=>id<=afterId||i>0&&id<=ids[i-1]!))
      fault("SPECIALIST_ORIGINAL_SERVICE_ORDER_INVALID",503);
    return Object.freeze(ids);
  }
  async decideOriginal(publicationId:string,decision:unknown,evidence:unknown){
    if(this.config.role!=="proof")fault("SPECIALIST_PROOF_ROLE_REQUIRED",403);
    await this.pool.query("SELECT finnor_specialist.decide_original($1,$2,$3,$4,$5,$6)",
      [...this.args(),publicationId,JSON.stringify(decision),digest(decision),JSON.stringify(evidence)]);
  }
  async projectOriginal(publicationId:string){
    if(this.config.role!=="projection")fault("SPECIALIST_HISTORICAL_PROJECTION_ROLE_REQUIRED",403);
    const verificationAbort=new AbortController();
    let failed=false,firstFailure:unknown,poisoned=false;
    const retainFailure=(error:unknown)=>{if(!failed){failed=true;firstFailure=error;}};
    const onClientError=(error:Error)=>{
      poisoned=true;retainFailure(error);
      if(!verificationAbort.signal.aborted)verificationAbort.abort(error);
    };
    const checkFailure=()=>{if(failed)throw firstFailure;};
    const client=await this.pool.connect();
    client.on("error",onClientError);
    let commitAttempted=false,committed=false,rollbackFailed=false,released=false;
    let projected:pg.QueryResult|undefined;
    try{
      checkFailure();
      // One snapshot prevents a decision appearing after a negative precheck
      // from entering SQL's accepted branch without the fresh-tail gate.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      checkFailure();
      const observed=(await client.query("SELECT finnor_specialist.observe_original($1,$2,$3) value",
        [...this.args(),publicationId])).rows[0]?.value;
      checkFailure();
      if(observed?.decision){
        if(!observed.candidateRow||observed.originalUpperCaptured!==true)
          fault("SPECIALIST_ORIGINAL_PROJECTION_FROZEN_SOURCE_REQUIRED",503);
        const row=observed.candidateRow,decision=observed.decision,
          candidate=candidateSchema.parse(row.candidate),
          pre=observationSchema.parse(row.pre_observation),
          post=observationSchema.parse(observed.postObservation);
        if(candidate.publicationId!==publicationId||row.candidate_digest!==digest(candidate)
          ||row.original_xid8!==pre.xid8||decision.status!=="ACCEPTED_ORIGINAL_COMMIT"
          ||decision.publicationId!==publicationId||decision.candidateDigest!==digest(candidate)
          ||decision.proposedDeltaDigest!==candidate.proposedDeltaDigest||decision.xid8!==pre.xid8
          ||digest(decision.primary)!==digest(candidate.primary))
          fault("SPECIALIST_ORIGINAL_PROJECTION_DECISION_CHANGED",503);
        // Import only after module initialization; never reopen this pool or
        // accept a caller-supplied witness/current-tail brand for projection.
        const {readOriginalPublicationWitness,assertVerifiedPublicationWitnessCurrentTails}=
          await import("../../governed-execution/src/specialist-publication-witness");
        checkFailure();
        const witness=await readOriginalPublicationWitness({
          enrollment:this.enrollment,candidate,pre,post,directory:this.config.witnessDirectory,
          expectedDirectory:this.config.witnessDirectory,
          originalSourceDigest:digest({intent:row.original_intent,nativeReady:row.original_sources?.nativeReady}),
          // Retain the existing 5000ms diagnostic limit, never an unbounded
          // replacement signal. Client loss can abort permitted I/O sooner.
          signal:AbortSignal.any([verificationAbort.signal,AbortSignal.timeout(5000)]),
        });
        checkFailure();
        assertVerifiedPublicationWitnessCurrentTails(witness);
        if(witness.candidateDigest!==decision.candidateDigest||witness.evidenceDigest!==decision.witnessDigest)
          fault("SPECIALIST_ORIGINAL_PROJECTION_FROZEN_WITNESS_CHANGED",503);
      }
      // No decision still reaches the real SELECT INTO STRICT/P0002 path.
      // Existing projections also reach SQL only after a fresh witness check.
      checkFailure();
      projected=await client.query("SELECT finnor_specialist.project_original($1,$2,$3) value",
        [...this.args(),publicationId]);
      checkFailure();
      commitAttempted=true;
      await client.query("COMMIT");
      checkFailure();committed=true;
    }catch(error){
      retainFailure(error);
      if(!commitAttempted&&!poisoned){
        try{await client.query("ROLLBACK");}catch(rollbackError){
          rollbackFailed=true;retainFailure(rollbackError);
        }
      }
    }finally{
      // Keep the listener through release. Never return a poisoned connection,
      // release twice, or remove protection if release itself fails.
      try{
        client.release(poisoned||rollbackFailed||commitAttempted&&!committed
          ?Error("SPECIALIST_ORIGINAL_PROJECTION_CONNECTION_CONSUMED"):undefined);
        released=true;
      }catch(error){poisoned=true;retainFailure(error);}
      finally{if(released)client.removeListener("error",onClientError);}
    }
    checkFailure();
    return projected?.rows[0]?.value;
  }
  async close(){await this.pool.end();}
}
export function assertCanonicalEpoch(epoch:CanonicalEpoch){
  if(!nativeFence.has(epoch))fault("SPECIALIST_ACTUAL_CANONICAL_EPOCH_REQUIRED",503);
}
