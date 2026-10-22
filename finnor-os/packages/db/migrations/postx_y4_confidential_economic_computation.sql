-- Namespaced additive migration. No shared peer ordinal is claimed.
-- This stores proposed functions, public protocol evidence and recipient-owned
-- outputs. It creates no S1 grant, protected admission or economic effect.
DO $y4_query_history$
DECLARE previous text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO STRICT previous FROM pg_constraint
  WHERE conrelid='finnor_os.work_query_executions'::regclass
   AND conname='work_query_executions_intent_check';
 IF previous NOT LIKE 'CHECK (%' THEN
  RAISE EXCEPTION 'Y4 requires the existing validated query-history predicate';
 END IF;
 ALTER TABLE finnor_os.work_query_executions DROP CONSTRAINT work_query_executions_intent_check;
 EXECUTE format('ALTER TABLE finnor_os.work_query_executions ADD CONSTRAINT work_query_executions_intent_check CHECK ((%s) OR intent=%L)',
  substring(previous FROM 7),'confidential_economic_computation_v1');
END $y4_query_history$;
CREATE TABLE finnor_os.y4_computations(
 tenant_id uuid NOT NULL,id uuid NOT NULL,principal_id uuid NOT NULL,
 root_type text NOT NULL,root_id uuid NOT NULL,work_id uuid NOT NULL,work_input_id uuid NOT NULL,
 work_input_digest text NOT NULL,request jsonb NOT NULL CHECK(octet_length(request::text)<=262144),
 request_digest text NOT NULL CHECK(request_digest~'^[a-f0-9]{64}$'),environment jsonb NOT NULL,
 deadline_at timestamptz NOT NULL,max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 1 AND 4),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND max_attempts),
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN(
  'QUEUED','COMPILING','AWAITING_PARTICIPANTS','READY','RUNNING','COMPUTED',
  'RECONCILIATION_REQUIRED','FAILED','CANCELLED','INVALIDATED','UNSUPPORTED')),
 protocol jsonb,correspondence jsonb,session jsonb,runtime_receipt jsonb,
 data_bytes bigint NOT NULL DEFAULT 0 CHECK(data_bytes BETWEEN 0 AND 16777216
  AND data_bytes<=(request->'limits'->>'maxRetainedBytes')::bigint),
 cpu_reserved_seconds integer NOT NULL DEFAULT 0 CHECK(cpu_reserved_seconds>=0
  AND cpu_reserved_seconds<=(request->'limits'->>'maxCpuSeconds')::integer),
 idempotency_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,principal_id,idempotency_key),UNIQUE(tenant_id,work_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id)
);
CREATE TABLE finnor_os.y4_consents(
 tenant_id uuid NOT NULL,computation_id uuid NOT NULL,participant_id text NOT NULL,principal_id uuid NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),body_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,computation_id,participant_id),
 FOREIGN KEY(tenant_id,computation_id) REFERENCES finnor_os.y4_computations(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.y4_revocations(
 tenant_id uuid NOT NULL,computation_id uuid NOT NULL,participant_id text NOT NULL,principal_id uuid NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=8192),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,computation_id,participant_id),
 FOREIGN KEY(tenant_id,computation_id,participant_id) REFERENCES finnor_os.y4_consents(tenant_id,computation_id,participant_id)
);
CREATE TABLE finnor_os.y4_disclosures(
 tenant_id uuid NOT NULL,institution_id uuid NOT NULL,source_key text NOT NULL,computation_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,institution_id,source_key),
 FOREIGN KEY(tenant_id,computation_id) REFERENCES finnor_os.y4_computations(tenant_id,id)
);
CREATE TABLE finnor_os.y4_commitments(
 tenant_id uuid NOT NULL,computation_id uuid NOT NULL,participant_id text NOT NULL,principal_id uuid NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),body_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,computation_id,participant_id),
 FOREIGN KEY(tenant_id,computation_id,participant_id) REFERENCES finnor_os.y4_consents(tenant_id,computation_id,participant_id)
);
CREATE TABLE finnor_os.y4_releases(
 tenant_id uuid NOT NULL,id uuid NOT NULL,computation_id uuid NOT NULL,participant_id text NOT NULL,principal_id uuid NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=262144),body_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,computation_id,participant_id),
 FOREIGN KEY(tenant_id,computation_id,participant_id) REFERENCES finnor_os.y4_consents(tenant_id,computation_id,participant_id)
);
CREATE TABLE finnor_os.y4_events(
 id bigserial PRIMARY KEY,tenant_id uuid NOT NULL,computation_id uuid NOT NULL,actor_id uuid NOT NULL,
 kind text NOT NULL,idempotency_key text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,computation_id,idempotency_key),
 FOREIGN KEY(tenant_id,computation_id) REFERENCES finnor_os.y4_computations(tenant_id,id)
);
CREATE INDEX y4_work ON finnor_os.y4_computations(tenant_id,work_id,created_at,id);
CREATE INDEX y4_events_by_computation ON finnor_os.y4_events(tenant_id,computation_id,id);
CREATE TABLE finnor_os.y4_source_handles(
 tenant_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),principal_id uuid NOT NULL,
 grant_id uuid NOT NULL,grant_version integer NOT NULL,private_cut jsonb NOT NULL
  CHECK(octet_length(private_cut::text)<=1048576),
 public_body jsonb NOT NULL CHECK(octet_length(public_body::text)<=8192),
 public_digest text NOT NULL CHECK(public_digest~'^[a-f0-9]{64}$'),valid_until timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,grant_id,grant_version),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,grant_id) REFERENCES finnor_os.x1_source_grants(tenant_id,id)
);
ALTER TABLE finnor_os.y4_source_handles ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.y4_source_handles FORCE ROW LEVEL SECURITY;
CREATE POLICY y4_source_owner ON finnor_os.y4_source_handles
 USING(tenant_id=finnor_os.request_tenant_id()
  AND principal_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
REVOKE ALL ON finnor_os.y4_source_handles FROM PUBLIC,finnor_app,finnor_worker;
GRANT SELECT ON finnor_os.y4_source_handles TO finnor_app;
CREATE TRIGGER y4_source_handle_immutable BEFORE UPDATE OR DELETE ON finnor_os.y4_source_handles
 FOR EACH ROW EXECUTE FUNCTION finnor_os.m3_immutable();
-- Internal comparison material. Never callable by the application, never
-- returned in a public handle, and never a replacement source authorizer.
CREATE FUNCTION finnor_os.y4_private_source_cut(t uuid,gid uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT jsonb_build_object('grant',to_jsonb(g),
  'actor',jsonb_build_object('id',actor.id,'status',actor.status,'role',actor.role),
  'work',jsonb_build_object('id',work.id,'createdBy',work.created_by),
  'mandates',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM finnor_os.x1_work_mandates m
   WHERE m.tenant_id=g.tenant_id AND m.work_id=g.work_id AND m.principal_id=g.principal_id
    AND m.revoked_at IS NULL AND m.valid_from<=clock_timestamp() AND m.expires_at>clock_timestamp()),'[]'),
  'bindings',coalesce((SELECT jsonb_agg(jsonb_build_object('binding',to_jsonb(b),'subjectStatus',u.status) ORDER BY b.id)
   FROM finnor_os.x1_subject_identity_bindings b LEFT JOIN finnor_os.users u
    ON u.tenant_id=b.tenant_id AND u.id=b.subject_user_id
   WHERE b.tenant_id=g.tenant_id AND b.source_id=g.source_id AND b.institution_id=g.institution_id
    AND b.revoked_at IS NULL AND b.valid_from<=clock_timestamp() AND b.expires_at>clock_timestamp()),'[]'),
  'consents',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM finnor_os.x1_subject_consents s
   WHERE s.tenant_id=g.tenant_id AND s.institution_id=g.institution_id AND s.source_class=g.source_class
    AND s.purpose=g.purpose AND s.revoked_at IS NULL
    AND s.granted_at<=clock_timestamp() AND s.expires_at>clock_timestamp()),'[]'))
 FROM finnor_os.x1_source_grants g
 JOIN finnor_os.users actor ON actor.tenant_id=g.tenant_id AND actor.id=g.principal_id
 JOIN finnor_os.works work ON work.tenant_id=g.tenant_id AND work.id=g.work_id AND work.created_by=g.principal_id
 WHERE g.tenant_id=t AND g.id=gid AND actor.status='active' AND actor.role='owner'
  AND g.revoked_at IS NULL AND g.valid_from<=clock_timestamp() AND g.expires_at>clock_timestamp()
  AND NOT EXISTS(SELECT 1 FROM finnor_os.x1_source_grants newer
   WHERE newer.tenant_id=g.tenant_id AND newer.principal_id=g.principal_id
    AND newer.work_id=g.work_id AND newer.source_id=g.source_id AND newer.version>g.version)
$$;
REVOKE ALL ON FUNCTION finnor_os.y4_private_source_cut(uuid,uuid) FROM PUBLIC,finnor_app,finnor_worker;
CREATE FUNCTION finnor_os.y4_issue_source_handle(w uuid,gid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id();u uuid:=NULLIF(current_setting('app.user_id',true),'')::uuid;
 scope jsonb;cut jsonb;body jsonb;hid uuid:=gen_random_uuid();expiry timestamptz;
 h finnor_os.y4_source_handles;
BEGIN
 PERFORM finnor_os.x1_lock_source_authority(w,ARRAY[gid]);
 scope:=finnor_os.x1_source_scope(w,gid);
 IF scope->'body'->>'originalReadAllowed' IS DISTINCT FROM 'true'
  OR scope->'body'->'gap' IS DISTINCT FROM 'null'::jsonb THEN
  RAISE EXCEPTION 'Y4_CURRENT_PARTICIPANT_SOURCE_OWNER_REQUIRED'; END IF;
 cut:=finnor_os.y4_private_source_cut(t,gid);
 IF cut IS NULL OR cut->'grant'->>'principal_id' IS DISTINCT FROM u::text
  OR jsonb_array_length(cut->'mandates')<>1 OR jsonb_array_length(cut->'bindings')>200
  OR jsonb_array_length(cut->'consents')>200 THEN
  RAISE EXCEPTION 'Y4_EXACT_SOURCE_AUTHORITY_CUT_REQUIRED'; END IF;
 SELECT min(value::timestamptz) INTO expiry FROM(
  SELECT cut->'grant'->>'expires_at' value
  UNION ALL SELECT value->>'expires_at' FROM jsonb_array_elements(cut->'mandates')
  UNION ALL SELECT value->'binding'->>'expires_at' FROM jsonb_array_elements(cut->'bindings')
  UNION ALL SELECT value->>'expires_at' FROM jsonb_array_elements(cut->'consents')) bounds;
 IF expiry IS NULL OR expiry<=clock_timestamp() THEN RAISE EXCEPTION 'Y4_SOURCE_AUTHORITY_EXPIRED'; END IF;
 SELECT * INTO h FROM finnor_os.y4_source_handles
  WHERE tenant_id=t AND grant_id=gid AND grant_version=(cut->'grant'->>'version')::integer;
 IF FOUND THEN
  IF h.principal_id<>u OR h.private_cut IS DISTINCT FROM cut OR h.valid_until<>expiry THEN
   RAISE EXCEPTION 'Y4_ORIGINAL_SOURCE_HANDLE_NOT_REPLACEABLE'; END IF;
  RETURN jsonb_build_object('id',h.id,'body',h.public_body,'digest',h.public_digest);
 END IF;
 body:=jsonb_build_object('schema','finnor.y4.opaque-source-handle.v1','id',hid,
  'principalId',u,'institutionId',cut->'grant'->>'institution_id','sourceId',cut->'grant'->>'source_id',
  'sourceRevision',cut->'grant'->>'revision','grantVersion',(cut->'grant'->>'version')::integer,
  'purpose',cut->'grant'->>'purpose','validUntil',expiry,'sourceTruthProven',false,'executionAuthorityGranted',false);
 INSERT INTO finnor_os.y4_source_handles(tenant_id,id,principal_id,grant_id,grant_version,private_cut,public_body,public_digest,valid_until)
  VALUES(t,hid,u,gid,(cut->'grant'->>'version')::integer,cut,body,
   encode(sha256(convert_to(body::text,'UTF8')),'hex'),expiry) RETURNING * INTO h;
 RETURN jsonb_build_object('id',h.id,'body',h.public_body,'digest',h.public_digest);
END $$;
REVOKE ALL ON FUNCTION finnor_os.y4_issue_source_handle(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.y4_issue_source_handle(uuid,uuid) TO finnor_app;
-- This can attest only the exact owner-issued cut already consented to this
-- computation. It returns no snapshot/hash/bytes and never impersonates an
-- owner, grants authority or prepares a cryptographic session.
CREATE FUNCTION finnor_os.y4_source_handle_current(qid uuid,pid text,hid uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id();u uuid:=NULLIF(current_setting('app.user_id',true),'')::uuid;
 h finnor_os.y4_source_handles;q finnor_os.y4_computations;consent finnor_os.y4_consents;
BEGIN
 SELECT * INTO q FROM finnor_os.y4_computations WHERE tenant_id=t AND id=qid;
 IF NOT FOUND OR q.deadline_at<=clock_timestamp() OR q.status IN('CANCELLED','INVALIDATED','UNSUPPORTED','FAILED') THEN RETURN false; END IF;
 SELECT * INTO h FROM finnor_os.y4_source_handles WHERE tenant_id=t AND id=hid;
 IF NOT FOUND OR h.valid_until<=clock_timestamp() THEN RETURN false; END IF;
 SELECT * INTO consent FROM finnor_os.y4_consents
  WHERE tenant_id=t AND computation_id=qid AND participant_id=pid AND principal_id=h.principal_id;
 IF NOT FOUND OR consent.body->>'functionDigest' IS DISTINCT FROM q.protocol->>'functionDigest'
  OR (consent.body->'request'->>'validUntil')::timestamptz<=clock_timestamp() THEN RETURN false; END IF;
 IF u IS DISTINCT FROM q.principal_id AND NOT EXISTS(SELECT 1 FROM finnor_os.y4_consents c
  WHERE c.tenant_id=t AND c.computation_id=qid AND c.principal_id=u) THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM finnor_os.y4_revocations r WHERE r.tenant_id=t AND r.computation_id=qid)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.request->'function'->'participants') p
   WHERE p->>'id'=pid AND p->>'institutionId'=h.public_body->>'institutionId')
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.request->'function'->'inputs') port
   WHERE port->>'participantId'=pid AND port->'grantRef'->>'owner'='Y4_SOURCE_AUTHORITY_HANDLE'
    AND port->'grantRef'->>'id'=hid::text AND port->'grantRef'->>'contentDigest'=h.public_digest
    AND port->'grantRef'->>'version'=h.grant_version::text
    AND port->'sourceRef'->>'owner'='Y4_SOURCE_VERSION_IDENTITY'
    AND port->'sourceRef'->>'id'=h.public_body->>'sourceId'
    AND port->'sourceRef'->>'version'=h.public_body->>'sourceRevision'
    AND port->'sourceRef'->>'contentDigest'=h.public_digest)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(consent.body->'sourceCuts') cut
   WHERE cut->>'handleId'=hid::text AND cut->>'digest'=h.public_digest)
  THEN RETURN false; END IF;
 RETURN h.private_cut IS NOT DISTINCT FROM finnor_os.y4_private_source_cut(t,h.grant_id);
END $$;
REVOKE ALL ON FUNCTION finnor_os.y4_source_handle_current(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.y4_source_handle_current(uuid,text,uuid) TO finnor_app;
CREATE FUNCTION finnor_os.y4_original_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF to_jsonb(NEW)-ARRAY['attempt_count','generation','status','protocol','correspondence','session','runtime_receipt','data_bytes','cpu_reserved_seconds']
 IS DISTINCT FROM to_jsonb(OLD)-ARRAY['attempt_count','generation','status','protocol','correspondence','session','runtime_receipt','data_bytes','cpu_reserved_seconds']
 OR NEW.attempt_count<OLD.attempt_count OR NEW.generation<OLD.generation OR NEW.data_bytes<OLD.data_bytes
 OR NEW.cpu_reserved_seconds<OLD.cpu_reserved_seconds
 OR (OLD.protocol IS NOT NULL AND NEW.protocol IS DISTINCT FROM OLD.protocol)
 OR (OLD.correspondence IS NOT NULL AND NEW.correspondence IS DISTINCT FROM OLD.correspondence)
 OR (OLD.session IS NOT NULL AND NEW.session IS DISTINCT FROM OLD.session)
 OR (OLD.runtime_receipt IS NOT NULL AND NEW.runtime_receipt IS DISTINCT FROM OLD.runtime_receipt)
 THEN RAISE EXCEPTION 'Y4 original allocation and checked artifacts cannot reset'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER y4_identity BEFORE UPDATE ON finnor_os.y4_computations
 FOR EACH ROW EXECUTE FUNCTION finnor_os.y4_original_identity();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['y4_computations','y4_consents','y4_revocations','y4_disclosures','y4_commitments','y4_releases','y4_events'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  IF t='y4_releases' THEN
   EXECUTE format('CREATE POLICY y4_recipient ON finnor_os.%I USING(
    tenant_id=finnor_os.request_tenant_id() AND principal_id=NULLIF(current_setting(''app.user_id'',true),'''')::uuid)
    WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=NULLIF(current_setting(''app.user_id'',true),'''')::uuid)',t);
  ELSE
   EXECUTE format('CREATE POLICY y4_tenant ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id())
    WITH CHECK(tenant_id=finnor_os.request_tenant_id())',t);
  END IF;
  EXECUTE format('REVOKE ALL ON finnor_os.%I FROM finnor_app',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  IF t='y4_computations' THEN
   EXECUTE format('GRANT UPDATE ON finnor_os.%I TO finnor_app',t);
  ELSE
   EXECUTE format('CREATE TRIGGER y4_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I
    FOR EACH ROW EXECUTE FUNCTION finnor_os.m3_immutable()',t);
  END IF;
 END LOOP;
END $$;
CREATE FUNCTION finnor_os.y4_retained_bytes() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE parent uuid;delta bigint;
BEGIN
 IF TG_TABLE_NAME='y4_computations' THEN parent:=NEW.id; ELSE parent:=NEW.computation_id; END IF;
 delta:=octet_length((to_jsonb(NEW)-'data_bytes')::text);
 IF TG_OP='UPDATE' THEN delta:=greatest(0,delta-octet_length((to_jsonb(OLD)-'data_bytes')::text)); END IF;
 IF delta>0 THEN UPDATE finnor_os.y4_computations SET data_bytes=data_bytes+delta
   WHERE tenant_id=NEW.tenant_id AND id=parent
    AND data_bytes+delta<=(request->'limits'->>'maxRetainedBytes')::bigint;
   IF NOT FOUND THEN RAISE EXCEPTION 'Y4_ORIGINAL_RETAINED_BYTE_LIMIT' USING ERRCODE='54000'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER y4_bytes AFTER INSERT ON finnor_os.y4_computations
 FOR EACH ROW EXECUTE FUNCTION finnor_os.y4_retained_bytes();
CREATE TRIGGER y4_update_bytes AFTER UPDATE ON finnor_os.y4_computations
 FOR EACH ROW WHEN ((to_jsonb(NEW)-'data_bytes') IS DISTINCT FROM (to_jsonb(OLD)-'data_bytes'))
 EXECUTE FUNCTION finnor_os.y4_retained_bytes();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['y4_consents','y4_revocations','y4_disclosures','y4_commitments','y4_releases','y4_events'] LOOP
  EXECUTE format('CREATE TRIGGER y4_bytes AFTER INSERT ON finnor_os.%I
   FOR EACH ROW EXECUTE FUNCTION finnor_os.y4_retained_bytes()',t);
 END LOOP;
END $$;
GRANT USAGE,SELECT ON SEQUENCE finnor_os.y4_events_id_seq TO finnor_app;
-- A confidential value remains recipient-scoped after entering the existing
-- typed consumer. Tenant membership alone must not expose its snapshot,
-- derivatives or hiding material. This is isolation, not source-currentness
-- or admission; the existing owner transaction still checks those predicates.
CREATE FUNCTION finnor_os.y4_recipient_snapshot_scope(p_tenant uuid,p_snapshot jsonb)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,finnor_os AS $$
 WITH refs AS (
  SELECT ref FROM jsonb_path_query(p_snapshot,
   '$.values.*.provenance[*] ? (@.kind == "confidential_computation")') AS item(ref)
 )
 SELECT p_tenant=finnor_os.request_tenant_id() AND NOT EXISTS(
  SELECT 1 FROM refs r WHERE NOT EXISTS(
   SELECT 1 FROM finnor_os.y4_releases l
   JOIN finnor_os.y4_computations q ON q.tenant_id=l.tenant_id AND q.id=l.computation_id
   WHERE l.tenant_id=p_tenant AND l.principal_id=NULLIF(current_setting('app.user_id',true),'')::uuid
    AND q.id::text=r.ref->>'id' AND l.id::text=r.ref->>'versionId'
    AND l.body_digest=r.ref->>'semanticHash'
    AND q.status='COMPUTED' AND q.deadline_at>clock_timestamp()
    AND NOT EXISTS(SELECT 1 FROM finnor_os.y4_revocations v
     WHERE v.tenant_id=q.tenant_id AND v.computation_id=q.id)
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(l.body->'outputs') AS output(value)
     WHERE output.value->>'key'=r.ref->>'anchorId')
  )
 )
$$;
REVOKE ALL ON FUNCTION finnor_os.y4_recipient_snapshot_scope(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.y4_recipient_snapshot_scope(uuid,jsonb) TO finnor_app,finnor_worker;
CREATE POLICY y4_recipient_derivative ON finnor_os.underwriting_runs AS RESTRICTIVE
 USING(finnor_os.y4_recipient_snapshot_scope(tenant_id,input_snapshot))
 WITH CHECK(finnor_os.y4_recipient_snapshot_scope(tenant_id,input_snapshot));
CREATE POLICY y4_recipient_derivative ON finnor_os.underwriting_sensitivities AS RESTRICTIVE
 USING(EXISTS(SELECT 1 FROM finnor_os.underwriting_runs r
  WHERE r.tenant_id=underwriting_sensitivities.tenant_id AND r.id=underwriting_sensitivities.base_run_id))
 WITH CHECK(EXISTS(SELECT 1 FROM finnor_os.underwriting_runs r
  WHERE r.tenant_id=underwriting_sensitivities.tenant_id AND r.id=underwriting_sensitivities.base_run_id));
CREATE POLICY y4_recipient_derivative ON finnor_os.underwriting_sensitivity_cells AS RESTRICTIVE
 USING(EXISTS(SELECT 1 FROM finnor_os.underwriting_runs r
  WHERE r.tenant_id=underwriting_sensitivity_cells.tenant_id AND r.id=underwriting_sensitivity_cells.run_id)
  AND EXISTS(SELECT 1 FROM finnor_os.underwriting_sensitivities s
   WHERE s.tenant_id=underwriting_sensitivity_cells.tenant_id AND s.id=underwriting_sensitivity_cells.sensitivity_id))
 WITH CHECK(EXISTS(SELECT 1 FROM finnor_os.underwriting_runs r
  WHERE r.tenant_id=underwriting_sensitivity_cells.tenant_id AND r.id=underwriting_sensitivity_cells.run_id)
  AND EXISTS(SELECT 1 FROM finnor_os.underwriting_sensitivities s
   WHERE s.tenant_id=underwriting_sensitivity_cells.tenant_id AND s.id=underwriting_sensitivity_cells.sensitivity_id));
INSERT INTO finnor_os.compute_job_type_policies
 (job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_confidential_economic_computation_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'Y4 checked public compilation and recipient-private MPC under an original Work; uncertain input-accepting sessions reconcile without resubmission. No protected or production authority.');
INSERT INTO finnor_os.compute_resource_policies
 (resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
 VALUES('native:y4-confidential',1,1,0,90,'Y4 serial checked compiler and local encrypted malicious-secure runtime; no authority for real effects');
