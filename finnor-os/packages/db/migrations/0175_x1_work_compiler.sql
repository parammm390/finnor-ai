-- Work-owned durable compiler metadata and immutable projections. S1/S4/P1,
-- S5 and native effects remain the semantic, resource and effect owners.
CREATE TABLE finnor_os.x1_compiler_episodes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
 principal_id uuid NOT NULL, work_id uuid NOT NULL, institution_id text NOT NULL,
 original_deadline timestamptz NOT NULL, wall_deadline timestamptz NOT NULL,
 profile_digest text NOT NULL CHECK(profile_digest ~ '^[a-f0-9]{64}$'),
 parent_reservation jsonb, parent_demand jsonb,
 acquisition_calls integer NOT NULL DEFAULT 0 CHECK(acquisition_calls BETWEEN 0 AND 128),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 4),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,work_id), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 CHECK(wall_deadline<=original_deadline),
 CHECK((parent_reservation IS NULL)=(parent_demand IS NULL))
);
CREATE TABLE finnor_os.x1_compiler_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
 principal_id uuid NOT NULL, work_id uuid NOT NULL, work_input_id uuid NOT NULL,
 work_input_digest text NOT NULL, episode_id uuid NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 160),
 request_digest text NOT NULL, grant_ids jsonb NOT NULL,
 revision integer NOT NULL CHECK(revision>=1), parent_request_id uuid,
 generation integer NOT NULL DEFAULT 1 CHECK(generation>=1),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN
  ('QUEUED','RUNNING','CHECK_REJECTED','WAITING','PARTIAL','OBSERVED','FAILED','INVALIDATED','CANCELLED','UNKNOWN')),
 claim_token uuid, claim_fence bigint, admission_id uuid, program_id uuid,
 artifact_id uuid, failure text, input_manifest jsonb, programme_digest text, intent_digest text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,principal_id,idempotency_key),
 UNIQUE(tenant_id,principal_id,work_id,revision),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,episode_id) REFERENCES finnor_os.x1_compiler_episodes(tenant_id,id),
 FOREIGN KEY(tenant_id,parent_request_id) REFERENCES finnor_os.x1_compiler_requests(tenant_id,id),
 CHECK(jsonb_typeof(grant_ids)='array' AND jsonb_array_length(grant_ids) BETWEEN 1 AND 16)
);
CREATE TABLE finnor_os.x1_compiler_artifacts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
 principal_id uuid NOT NULL, request_id uuid NOT NULL, generation integer NOT NULL,
 candidate jsonb NOT NULL, check_result jsonb NOT NULL, body jsonb NOT NULL,
 body_digest text NOT NULL CHECK(body_digest ~ '^[a-f0-9]{64}$'),
 input_manifest jsonb NOT NULL, dependency_graph jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_id,generation),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.x1_compiler_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 CHECK(octet_length(body::text)<=8388608 AND octet_length(candidate::text)<=8388608)
);
CREATE TABLE finnor_os.x1_compiler_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
 principal_id uuid NOT NULL, request_id uuid NOT NULL, generation integer NOT NULL,
 kind text NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.x1_compiler_requests(tenant_id,id),
 CHECK(octet_length(body::text)<=262144)
);
CREATE INDEX x1_compiler_work_head ON finnor_os.x1_compiler_requests(tenant_id,principal_id,work_id,revision DESC);
CREATE INDEX x1_compiler_events_request ON finnor_os.x1_compiler_events(tenant_id,request_id,created_at,id);
CREATE TRIGGER x1_compiler_artifacts_immutable BEFORE UPDATE OR DELETE ON finnor_os.x1_compiler_artifacts
 FOR EACH ROW EXECUTE FUNCTION finnor_os.p1_immutable();
CREATE TRIGGER x1_compiler_events_immutable BEFORE UPDATE OR DELETE ON finnor_os.x1_compiler_events
 FOR EACH ROW EXECUTE FUNCTION finnor_os.p1_immutable();
CREATE FUNCTION finnor_os.x1_original_episode_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.tenant_id<>OLD.tenant_id OR NEW.principal_id<>OLD.principal_id
   OR NEW.work_id<>OLD.work_id OR NEW.institution_id<>OLD.institution_id
   OR NEW.original_deadline<>OLD.original_deadline OR NEW.wall_deadline<>OLD.wall_deadline
   OR NEW.profile_digest<>OLD.profile_digest OR NEW.acquisition_calls<OLD.acquisition_calls
   OR NEW.attempts<OLD.attempts
   OR (OLD.parent_reservation IS NOT NULL AND
       (NEW.parent_reservation IS DISTINCT FROM OLD.parent_reservation OR NEW.parent_demand IS DISTINCT FROM OLD.parent_demand))
 THEN RAISE EXCEPTION 'X1 original Work envelope cannot be reset'; END IF;
 RETURN NEW;
 END $$;
CREATE TRIGGER x1_original_episode_immutable BEFORE UPDATE OR DELETE ON finnor_os.x1_compiler_episodes
 FOR EACH ROW EXECUTE FUNCTION finnor_os.x1_original_episode_guard();
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['x1_compiler_episodes','x1_compiler_requests','x1_compiler_artifacts','x1_compiler_events'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY %I ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',tab||'_principal',tab);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
   EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',tab);
   IF tab IN ('x1_compiler_requests','x1_compiler_episodes') THEN
    EXECUTE format('GRANT UPDATE ON finnor_os.%I TO finnor_app',tab);
   END IF;
  END IF;
 END LOOP;
END $$;

-- Checked artifacts remain immutable owner publications, not caller-written
-- credentials. Bind them to the admission's original, candidate and checker cut.
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
 REVOKE INSERT ON finnor_os.x1_checked_artifacts FROM finnor_app;
END IF; END $$;
ALTER TABLE finnor_os.x1_checked_artifacts ADD COLUMN responsibilities jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE finnor_os.x1_checked_artifacts ADD COLUMN unresolved jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE FUNCTION finnor_os.x1_publish_checked_artifact(p_admission uuid,p_candidate jsonb,
 p_check jsonb,p_check_digest text,p_duties jsonb,p_unresolved jsonb)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id(); u uuid:=nullif(current_setting('app.user_id',true),'')::uuid; a record;
BEGIN
 SELECT * INTO a FROM finnor_os.x1_mapping_admissions
  WHERE tenant_id=t AND principal_id=u AND id=p_admission;
 IF a IS NULL OR p_check->>'disposition'<>'ACCEPTED_DEVELOPMENT'
   OR p_check->>'inputDigest'<>a.original_digest OR p_check->>'candidateDigest'<>a.candidate_digest
   OR p_check->>'checkerRevision'<>a.checker_digest
   OR p_candidate->>'tenantId'<>t::text OR p_candidate->>'principalId'<>u::text
   OR p_candidate->>'workId'<>a.work_id::text OR p_candidate->'receipt'<>'null'::jsonb
   OR jsonb_array_length(p_duties)+jsonb_array_length(p_unresolved)>128
   OR NOT EXISTS(SELECT 1 FROM finnor_os.works WHERE tenant_id=t AND id=a.work_id AND created_by=u)
 THEN RAISE EXCEPTION 'X1 checked artifact does not match its owner admission'; END IF;
 INSERT INTO finnor_os.x1_checked_artifacts(tenant_id,principal_id,work_id,admission_id,
  candidate,candidate_digest,check_result,check_digest,responsibilities,unresolved)
 VALUES(t,u,a.work_id,a.id,p_candidate,a.candidate_digest,p_check,p_check_digest,p_duties,p_unresolved)
 ON CONFLICT(tenant_id,admission_id) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM finnor_os.x1_checked_artifacts WHERE tenant_id=t AND admission_id=a.id
  AND candidate=p_candidate AND check_result=p_check AND responsibilities=p_duties AND unresolved=p_unresolved)
 THEN RAISE EXCEPTION 'X1 checked artifact replay conflict'; END IF;
END $$;
REVOKE ALL ON FUNCTION finnor_os.x1_publish_checked_artifact(uuid,jsonb,jsonb,text,jsonb,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
 GRANT EXECUTE ON FUNCTION finnor_os.x1_publish_checked_artifact(uuid,jsonb,jsonb,text,jsonb,jsonb) TO finnor_app;
END IF; END $$;

INSERT INTO finnor_os.compute_job_type_policies
 (job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_x1_institution_compiler_v1','INTERACTIVE',ARRAY['INTERACTIVE'],
  'fixed','tenant','required',1,'Authenticated source reconstruction and original-evidence check for an exact Work revision; no protected authority.');

CREATE FUNCTION finnor_os.x1_s5_charge_authorized(p_origin jsonb,p_identity text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id(); u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
 IF t IS NULL OR u IS NULL OR p_origin->>'tenantId' IS DISTINCT FROM t::text
  OR p_origin->>'principalId' IS DISTINCT FROM u::text THEN RETURN false; END IF;
 IF p_origin->'demand'->'responsibilityIdentities' ? p_identity THEN RETURN true; END IF;
 IF p_origin->'demand'->'chargeScope'->>'kind' IS DISTINCT FROM 'ORIGINAL_WORK_EPISODE'
  THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM finnor_os.x1_compiler_episodes e
  JOIN finnor_os.x1_compiler_requests r ON r.tenant_id=e.tenant_id AND r.episode_id=e.id
  JOIN finnor_os.x1_checked_artifacts a ON a.tenant_id=r.tenant_id AND a.admission_id=r.admission_id
  CROSS JOIN LATERAL jsonb_array_elements(a.responsibilities) duty
  WHERE e.tenant_id=t AND e.principal_id=u AND e.id=(p_origin->'demand'->'chargeScope'->>'episodeId')::uuid
   AND e.parent_reservation=p_origin->'ref' AND e.work_id=(p_origin->>'workId')::uuid
   AND r.principal_id=u AND r.status IN('RUNNING','WAITING','PARTIAL')
   AND duty->'obligation'->>'stableIdentity'=p_identity
   AND NOT EXISTS(SELECT 1 FROM finnor_os.x1_compiler_requests newer
    WHERE newer.tenant_id=t AND newer.principal_id=u AND newer.work_id=e.work_id AND newer.revision>r.revision));
END $$;
REVOKE ALL ON FUNCTION finnor_os.x1_s5_charge_authorized(jsonb,text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
 GRANT EXECUTE ON FUNCTION finnor_os.x1_s5_charge_authorized(jsonb,text) TO finnor_app;
END IF; END $$;

-- Preserve the original S5 serializer, charge identities and occupancy writer.
-- Add original Work scope and compiler-attempt classifications only.
ALTER TABLE finnor_os.s5_governed_resource_charges
 DROP CONSTRAINT s5_governed_resource_charges_phase_check;
ALTER TABLE finnor_os.s5_governed_resource_charges
 ADD CONSTRAINT s5_governed_resource_charges_phase_check CHECK(
  phase IN('EXECUTION','RECOVERY','HUMAN') OR
  (body->>'schema' IS NOT DISTINCT FROM 'finnor.s5.institution-consumption.v1'
   AND phase IN('ACQUISITION','CHECK','COMPILE')));
CREATE OR REPLACE FUNCTION finnor_os.s5_consume_institution(p_reservation_id text,p_body jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE v_tenant uuid:=finnor_os.request_tenant_id();
  v_user uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  v_origin jsonb; v_status text; v_prior jsonb; v_used numeric; v_limit numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('s5-portfolio:'||v_tenant::text,0));
  SELECT o.body,s.status INTO v_origin,v_status FROM finnor_os.s5_reservation_origins o
    JOIN finnor_os.s5_reservations s USING(tenant_id,reservation_id)
    WHERE o.tenant_id=v_tenant AND o.principal_id=v_user AND o.reservation_id=p_reservation_id
      AND o.body->>'schema'='finnor.s5.institution-reservation.v1' FOR UPDATE OF s;
  IF v_origin IS NULL OR v_status='RELEASED' OR p_body->>'schema'<>'finnor.s5.institution-consumption.v1'
    OR p_body->'reservationRef'<>v_origin->'ref'
    OR p_body->>'originalDeadline'<>v_origin->>'originalDeadline'
    OR p_body->>'parentWorkId'<>v_origin->>'workId'
    OR p_body->'ref'->>'owner'<>'S5'
    OR p_body->'ref'->>'id' IS NULL
    OR (v_origin->>'originalDeadline')::timestamptz<=clock_timestamp()
    OR v_origin->>'rightsRevision' IS DISTINCT FROM (
      SELECT revision::text FROM finnor_os.authority_states WHERE tenant_id=v_tenant)
    OR v_origin->'resources' IS DISTINCT FROM (
      SELECT coalesce(jsonb_agg(r.body->'ref' ORDER BY r.resource_id),'[]'::jsonb)
      FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h
        USING(tenant_id,resource_id,revision) WHERE r.tenant_id=v_tenant)
    OR NOT EXISTS(SELECT 1 FROM finnor_os.x1_work_mandates m
      WHERE m.tenant_id=v_tenant AND m.work_id=(v_origin->>'workId')::uuid
        AND m.principal_id=v_user AND m.institution_id=v_origin->'demand'->>'institutionId'
        AND m.revoked_at IS NULL AND m.valid_from<=clock_timestamp()
        AND m.expires_at>clock_timestamp()
        AND (SELECT min(rule->>'deadlineAt') FROM jsonb_array_elements(m.rules) rule)
          =v_origin->>'originalDeadline')
    OR NOT finnor_os.x1_s5_charge_authorized(v_origin,p_body->>'responsibilityIdentity')
  THEN RAISE EXCEPTION 'S5 institution consumption not current'; END IF;
  IF p_body->>'chargeKey'<>('x1-charge:'||encode(sha256(convert_to(replace(
      jsonb_build_array(v_origin->'demand'->>'demandDigest',p_body->>'responsibilityIdentity',
        p_body->>'phase',(p_body->>'ordinal')::integer)::text,', ',','),'UTF8')),'hex'))
    OR p_body->>'requestDigest'<>encode(sha256(convert_to(replace(
      jsonb_build_array('institution-charge-request-v1',v_origin->'demand'->>'demandDigest',
        p_body->>'responsibilityIdentity',p_body->>'phase',
        (p_body->>'ordinal')::integer,(p_body->>'units')::integer)::text,', ',','),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'S5 institution charge semantic identity mismatch'; END IF;
  SELECT body INTO v_prior FROM finnor_os.s5_consumptions
    WHERE tenant_id=v_tenant AND principal_id=v_user AND idempotency_key=p_body->>'chargeKey';
  IF FOUND THEN
    IF v_prior<>p_body THEN RAISE EXCEPTION 'S5 institution charge replay conflict'; END IF;
    RETURN v_prior;
  END IF;
  IF (SELECT count(*) FROM finnor_os.s5_consumptions
    WHERE tenant_id=v_tenant AND reservation_id=p_reservation_id)>=(CASE
      WHEN v_origin->'demand'->'chargeScope' IS NULL THEN 512 ELSE 1420 END)
    THEN RAISE EXCEPTION 'S5 institution original charge bound exhausted'; END IF;
  SELECT COALESCE(sum(units),0) INTO v_used FROM finnor_os.s5_governed_resource_charges
    WHERE tenant_id=v_tenant AND reservation_id=p_reservation_id AND resource_id=p_body->>'resourceId';
  SELECT max((e->'quantities'->>0)::numeric) INTO v_limit
    FROM jsonb_array_elements(v_origin->'envelopes') e
    WHERE e->>'resourceId'=p_body->>'resourceId' AND e->>'unit'=p_body->>'unit';
  IF v_limit IS NULL OR (p_body->>'units')::integer NOT BETWEEN 1 AND 100000
    OR (p_body->>'phase') NOT IN ('EXECUTION','RECOVERY','HUMAN','ACQUISITION','CHECK','COMPILE')
    OR (p_body->>'ordinal')::integer NOT BETWEEN 1 AND (CASE
      WHEN v_origin->'demand'->'chargeScope' IS NULL THEN 64
      WHEN p_body->>'phase'='RECOVERY' THEN LEAST(1024,coalesce((SELECT max_steps FROM finnor_os.p1_episodes
        WHERE tenant_id=v_tenant AND principal_id=v_user AND work_id=(v_origin->>'workId')::uuid),128))
      ELSE 128 END)
    OR v_used+(p_body->>'units')::integer>v_limit
    OR (p_body->>'phase'='HUMAN' AND p_body->>'unit'<>'seconds')
    OR (p_body->>'phase'<>'HUMAN' AND p_body->>'unit'<>'request')
    OR NOT EXISTS(SELECT 1 FROM finnor_os.s5_resources r
      JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision)
      WHERE r.tenant_id=v_tenant AND r.resource_id=p_body->>'resourceId'
        AND r.body->>'resourceClass'=CASE WHEN p_body->>'phase'='HUMAN'
          THEN 'HUMAN_ATTENTION' ELSE 'COMPUTE' END
        AND (r.body->>'revoked')::boolean=false
        AND (r.body->>'validUntil')::timestamptz>clock_timestamp())
    OR p_body->>'usedAfter'<>(v_used+(p_body->>'units')::integer)::text
  THEN RAISE EXCEPTION 'S5 institution original parent charge exceeds envelope'; END IF;
  INSERT INTO finnor_os.s5_consumptions(tenant_id,principal_id,consumption_id,reservation_id,
    policy_id,node_id,idempotency_key,request_digest,body)
    VALUES(v_tenant,v_user,p_body->'ref'->>'id',p_reservation_id,
      p_body->>'responsibilityIdentity',p_body->>'chargeKey',p_body->>'chargeKey',
      p_body->>'requestDigest',p_body);
  INSERT INTO finnor_os.s5_consumption_states(tenant_id,consumption_id,status,revision)
    VALUES(v_tenant,p_body->'ref'->>'id','INTENDED_PENDING_S6',1);
  INSERT INTO finnor_os.s5_governed_resource_charges(tenant_id,principal_id,reservation_id,
    consumption_id,charge_key,phase,resource_id,unit,units,request_digest,body)
    VALUES(v_tenant,v_user,p_reservation_id,p_body->'ref'->>'id',p_body->>'chargeKey',
      p_body->>'phase',p_body->>'resourceId',p_body->>'unit',
      (p_body->>'units')::integer,p_body->>'requestDigest',p_body);
  UPDATE finnor_os.s5_reservations SET status='CONSUMPTION_PENDING',revision=revision+1
    WHERE tenant_id=v_tenant AND reservation_id=p_reservation_id AND status='RESERVED';
  RETURN p_body;
END $$;

-- Revalidate X1 at the canonical mutation, in the same transaction as the
-- effect. Locked source/mandate/rights/Work rows fence concurrent revocation.
CREATE FUNCTION finnor_os.x1_assert_canonical_owner_cut(p_cut jsonb,p_lock boolean DEFAULT false)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id(); binding jsonb; parts text[]; tab text;
 predicate text; query_text text; owner_row jsonb; owner_count integer;
 lock_suffix text:=CASE WHEN p_lock THEN ' FOR SHARE' ELSE '' END;
BEGIN
 IF t IS NULL OR p_cut IS NULL OR jsonb_typeof(p_cut)<>'array' OR jsonb_array_length(p_cut)>1000
 THEN RAISE EXCEPTION 'X1_CANONICAL_OWNER_CUT_REQUIRED'; END IF;
 FOR binding IN SELECT value FROM jsonb_array_elements(p_cut) LOOP
  parts:=regexp_match(binding->>'ref','^([a-z_]+):([a-f0-9-]{36})@(v[1-9][0-9]*|s[a-f0-9]{64})$');
  IF parts IS NULL OR coalesce(binding->>'registrationId','')='' OR coalesce(binding->>'institutionId','')=''
  THEN RAISE EXCEPTION 'X1_CANONICAL_OWNER_CUT_INVALID'; END IF;
  tab:=NULL; predicate:=NULL;
  CASE parts[1]
   WHEN 'pe_deal' THEN tab:='pe_deals';predicate:='archived_at IS NULL AND status=''active''';
   WHEN 'pe_fund' THEN tab:='pe_funds';predicate:='status<>''liquidated''';
   WHEN 'pe_vehicle' THEN tab:='pe_vehicles';predicate:='status<>''liquidated''';
   WHEN 'pe_investment_case' THEN tab:='pe_investment_cases';predicate:='archived_at IS NULL AND superseded_at IS NULL';
   WHEN 'pe_debt_facility' THEN tab:='pe_debt_facilities';predicate:='superseded_at IS NULL AND valid_to IS NULL AND status NOT IN(''cancelled'',''repaid'')';
   WHEN 'pe_metric_series' THEN tab:='pe_metric_series';predicate:='active';
   WHEN 'pe_request' THEN tab:='pe_requests';predicate:='archived_at IS NULL';
   WHEN 'pe_finding' THEN tab:='pe_findings';predicate:='archived_at IS NULL AND superseded_at IS NULL';
   WHEN 'pe_decision' THEN tab:='pe_decisions';predicate:='superseded_at IS NULL';
   WHEN 'pe_fund_vehicle_link' THEN tab:='pe_fund_vehicle_links';predicate:='superseded_at IS NULL AND valid_to IS NULL';
   WHEN 'pe_company_party_role' THEN tab:='pe_company_party_roles';predicate:='superseded_at IS NULL AND valid_to IS NULL';
   WHEN 'pe_debt_facility_lender' THEN tab:='pe_debt_facility_lenders';predicate:='superseded_at IS NULL AND valid_to IS NULL';
   WHEN 'pe_dependency' THEN tab:='pe_dependencies';predicate:='removed_at IS NULL';
   ELSE NULL;
  END CASE;
  IF tab IS NOT NULL THEN
   query_text:='SELECT to_jsonb(o) FROM finnor_os.'||quote_ident(tab)||' o WHERE tenant_id=$1 AND id=$2
    AND external_id=$3 AND source_system=''x1:''||$4 AND '||predicate||lock_suffix;
   EXECUTE query_text INTO owner_row USING t,parts[2]::uuid,binding->>'registrationId',binding->>'institutionId';
   IF owner_row IS NULL OR parts[3] IS DISTINCT FROM 'v'||(owner_row->>'version')
   THEN RAISE EXCEPTION 'X1_CANONICAL_OWNER_CHANGED'; END IF;
  ELSE
   IF left(parts[3],1)<>'s' OR jsonb_typeof(binding->'ownerWitness') IS DISTINCT FROM 'object'
   THEN RAISE EXCEPTION 'X1_CANONICAL_OWNER_WITNESS_REQUIRED'; END IF;
   CASE parts[1]
    WHEN 'user' THEN query_text:='SELECT jsonb_build_object(''bindingId'',b.id,''sourceId'',b.source_id,
      ''registrationId'',b.registration_id,''revision'',b.revision,''subjectId'',b.subject_user_id)
      FROM finnor_os.x1_subject_identity_bindings b JOIN finnor_os.users u
       ON u.tenant_id=b.tenant_id AND u.id=b.subject_user_id
      WHERE b.tenant_id=$1 AND b.registration_id=$3 AND b.institution_id=$4 AND b.source_id=$5
       AND b.revoked_at IS NULL AND b.valid_from<=clock_timestamp() AND b.expires_at>clock_timestamp()
       AND u.status=''active'''||CASE WHEN p_lock THEN ' FOR SHARE OF b,u' ELSE '' END;
    WHEN 'external_organization' THEN query_text:='SELECT jsonb_build_object(''organizationKey'',organization_key,''active'',active)
      FROM finnor_os.external_organizations WHERE tenant_id=$1 AND id=$2 AND organization_key=$3 AND active'||lock_suffix;
    WHEN 'document' THEN query_text:='SELECT jsonb_build_object(''id'',d.id,''externalId'',d.external_id,''sourceSystem'',d.source_system,
       ''heads'',coalesce((SELECT jsonb_agg(jsonb_build_object(''kind'',h.kind,''headKey'',h.head_key,
        ''versionId'',h.version_id,''sha256'',v.byte_sha256) ORDER BY h.kind,h.head_key)
        FROM finnor_os.document_version_heads h JOIN finnor_os.document_versions v
         ON v.tenant_id=h.tenant_id AND v.id=h.version_id AND v.document_id=h.document_id
        WHERE h.tenant_id=d.tenant_id AND h.document_id=d.id),''[]''::jsonb))
      FROM finnor_os.documents d WHERE d.tenant_id=$1 AND d.id=$2 AND d.archived_at IS NULL
       AND (d.id::text=$3 OR (d.source_system=''x1:''||$4 AND d.external_id=$3))'||lock_suffix;
    WHEN 'work' THEN query_text:='SELECT jsonb_build_object(''id'',id,''principalId'',created_by)
      FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 AND id::text=$3
       AND created_by=nullif(current_setting(''app.user_id'',true),'''')::uuid'||lock_suffix;
    ELSE RAISE EXCEPTION 'X1_CANONICAL_OWNER_TYPE_UNSUPPORTED';
   END CASE;
   owner_count:=0;
   FOR owner_row IN EXECUTE query_text USING t,parts[2]::uuid,binding->>'registrationId',binding->>'institutionId',binding->>'sourceId' LOOP
    owner_count:=owner_count+1;
    IF (parts[1]='user' AND owner_row->>'subjectId' IS DISTINCT FROM parts[2])
     OR (owner_row-'subjectId') IS DISTINCT FROM binding->'ownerWitness'
    THEN RAISE EXCEPTION 'X1_CANONICAL_OWNER_CHANGED'; END IF;
   END LOOP;
   IF owner_count<>1 THEN RAISE EXCEPTION 'X1_CANONICAL_OWNER_CHANGED_OR_AMBIGUOUS'; END IF;
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION finnor_os.x1_assert_canonical_owner_cut(jsonb,boolean) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
 GRANT EXECUTE ON FUNCTION finnor_os.x1_assert_canonical_owner_cut(jsonb,boolean) TO finnor_app;
END IF; END $$;

CREATE FUNCTION finnor_os.x1_assert_effect_current(p_action uuid,p_method text DEFAULT NULL)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id(); u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
 a record; p record; x record; e record; node jsonb; grant_row record; rights text; subject jsonb; subject_count integer;
BEGIN
 SELECT * INTO a FROM finnor_os.domain_actions WHERE tenant_id=t AND id=p_action;
 IF a IS NULL OR a.authority_context->>'kind' IS DISTINCT FROM 'institution_duty' THEN RETURN; END IF;
 IF u IS NULL OR a.initiated_by IS DISTINCT FROM u OR a.work_id IS NULL
  OR a.action_type NOT IN('create_deal_request','open_workstream','record_finding')
  OR EXISTS(SELECT 1 FROM finnor_os.s6_obligation_origins WHERE tenant_id=t AND domain_action_id=a.id)
 THEN RAISE EXCEPTION 'X1 ordinary effect scope or governed origin changed'; END IF;
 SELECT * INTO p FROM finnor_os.p1_requests WHERE tenant_id=t AND principal_id=u
  AND id=(a.authority_context->>'programId')::uuid AND work_id=a.work_id FOR SHARE;
 IF p IS NULL OR p.request->>'kind'<>'institution_responsibility_v1'
  OR p.status NOT IN('RUNNING','WAITING','PARTIAL') OR a.status<>'executing'
  OR p.work_input_id IS DISTINCT FROM (SELECT id FROM finnor_os.work_inputs
    WHERE tenant_id=t AND work_id=a.work_id ORDER BY created_at DESC,id DESC LIMIT 1)
  OR NOT EXISTS(SELECT 1 FROM finnor_os.work_plan_revisions WHERE tenant_id=t
    AND id=p.plan_revision_id AND work_input_id=p.work_input_id AND status='active')
 THEN RAISE EXCEPTION 'X1 programme, Work or active plan changed'; END IF;
 SELECT n INTO node FROM jsonb_array_elements(p.proposed->'nodes') n
  WHERE n->>'stableIdentity'=a.authority_context->>'stableIdentity'
   AND n->'action'->>'expectedEntityId'=a.id::text;
 IF node IS NULL OR node->>'operation'<>a.action_type
  OR (node->>'deadlineAt')::timestamptz<=clock_timestamp()
  OR (p.proposed->'bounds'->>'deadlineAt')::timestamptz<=clock_timestamp()
  OR (a.payload-'workId'-'grounding') IS DISTINCT FROM node->'action'->'payload'
  OR a.payload->>'workId' IS DISTINCT FROM a.work_id::text
  OR a.payload->'grounding'->'work'->>'entityId' IS DISTINCT FROM a.work_id::text
  OR a.payload->'grounding'->'deal'->>'entityId' IS DISTINCT FROM a.payload->>'dealId'
 THEN RAISE EXCEPTION 'X1 frozen ordinary intent or original deadline changed'; END IF;
 PERFORM 1 FROM finnor_os.users WHERE tenant_id=t AND id=u AND role='owner' AND status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'X1 current principal is unavailable'; END IF;
 PERFORM 1 FROM finnor_os.users WHERE tenant_id=t
  AND id=(node->'action'->'payload'->'owner'->>'partyId')::uuid AND status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'X1 responsible employee was revoked'; END IF;
 SELECT revision::text INTO rights FROM finnor_os.authority_states WHERE tenant_id=t FOR SHARE;
 IF p.request->'institution'->>'compilerRequestId' IS NOT NULL THEN
  SELECT * INTO x FROM finnor_os.x1_compiler_requests WHERE tenant_id=t AND principal_id=u
   AND id=(p.request->'institution'->>'compilerRequestId')::uuid AND work_id=a.work_id FOR SHARE;
  IF x IS NULL OR x.status NOT IN('RUNNING','WAITING','PARTIAL')
   OR x.work_input_id<>p.work_input_id
   OR x.input_manifest->'current'->>'rightsRevision' IS DISTINCT FROM rights
   OR p_method IS NULL OR x.input_manifest->'current'->>'methodRevision' IS DISTINCT FROM p_method
   OR x.admission_id IS NULL THEN RAISE EXCEPTION 'X1 compiler continuation was fenced'; END IF;
  PERFORM finnor_os.x1_assert_canonical_owner_cut(x.input_manifest->'current'->'canonicalOwners',true);
  SELECT * INTO e FROM finnor_os.x1_compiler_episodes WHERE tenant_id=t AND principal_id=u AND id=x.episode_id FOR SHARE;
  IF e IS NULL OR e.wall_deadline<=clock_timestamp()
   OR e.parent_reservation IS DISTINCT FROM p.request->'institution'->'reservationRef'
  THEN RAISE EXCEPTION 'X1 original parent envelope expired or changed'; END IF;
  IF (SELECT count(*) FROM finnor_os.x1_source_grants WHERE tenant_id=t AND principal_id=u AND work_id=a.work_id AND id IN(SELECT value::uuid FROM jsonb_array_elements_text(x.grant_ids)))<>jsonb_array_length(x.grant_ids) THEN RAISE EXCEPTION 'X1 source population changed'; END IF;
  FOR grant_row IN SELECT * FROM finnor_os.x1_source_grants g
   WHERE g.tenant_id=t AND g.principal_id=u AND g.work_id=a.work_id
    AND g.id IN(SELECT value::uuid FROM jsonb_array_elements_text(x.grant_ids)) FOR SHARE OF g LOOP
   IF grant_row.revoked_at IS NOT NULL OR grant_row.valid_from>clock_timestamp() OR grant_row.expires_at<=clock_timestamp()
    OR x.input_manifest->'current'->'sourceRevisions'->>grant_row.source_id IS DISTINCT FROM grant_row.revision
    OR EXISTS(SELECT 1 FROM finnor_os.x1_source_grants newer WHERE newer.tenant_id=t
      AND newer.principal_id=u AND newer.work_id=a.work_id AND newer.source_id=grant_row.source_id AND newer.version>grant_row.version)
   THEN RAISE EXCEPTION 'X1 source grant changed before canonical mutation'; END IF;
  END LOOP;
  FOR subject IN SELECT value FROM jsonb_array_elements(coalesce(x.input_manifest->'current'->'sensitiveSubjects','[]'::jsonb)) LOOP
   PERFORM 1 FROM finnor_os.x1_subject_identity_bindings b JOIN finnor_os.x1_subject_consents co
    ON co.tenant_id=b.tenant_id AND co.subject_user_id=b.subject_user_id AND co.institution_id=b.institution_id
    AND co.source_class=subject->>'sourceClass' AND co.purpose=subject->>'purpose'
    JOIN finnor_os.users u ON u.tenant_id=b.tenant_id AND u.id=b.subject_user_id
    WHERE b.tenant_id=t AND b.institution_id=subject->>'institutionId' AND b.source_id=subject->>'sourceId'
     AND b.registration_id IN(SELECT value FROM jsonb_array_elements_text(subject->'registrations'))
     AND b.revoked_at IS NULL AND b.valid_from<=clock_timestamp() AND b.expires_at>clock_timestamp()
     AND co.revoked_at IS NULL AND co.granted_at<=clock_timestamp() AND co.expires_at>clock_timestamp()
     AND u.status='active' FOR SHARE OF b,co,u;
   GET DIAGNOSTICS subject_count = ROW_COUNT;
   IF subject_count<>jsonb_array_length(subject->'registrations') THEN RAISE EXCEPTION 'X1 consent or subject identity changed before mutation'; END IF;
  END LOOP;
  PERFORM 1 FROM finnor_os.x1_work_mandates m WHERE m.tenant_id=t AND m.principal_id=u AND m.work_id=a.work_id
   AND m.revoked_at IS NULL AND m.valid_from<=clock_timestamp() AND m.expires_at>clock_timestamp()
   AND m.revision=x.input_manifest->'current'->>'mandateRevision' FOR SHARE OF m;
  IF NOT FOUND THEN RAISE EXCEPTION 'X1 standing mandate changed before canonical mutation'; END IF;
 END IF;
 PERFORM 1 FROM finnor_os.s5_reservations r JOIN finnor_os.s5_reservation_origins o USING(tenant_id,reservation_id)
  WHERE r.tenant_id=t AND o.principal_id=u AND r.reservation_id=p.request->'institution'->'reservationRef'->>'id'
   AND r.status<>'RELEASED' AND r.revocation_reason IS NULL
   AND o.body->>'rightsRevision'=rights FOR SHARE OF r,o;
 IF NOT FOUND THEN RAISE EXCEPTION 'X1 original S5 reservation changed before canonical mutation'; END IF;
END $$;
REVOKE ALL ON FUNCTION finnor_os.x1_assert_effect_current(uuid,text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
 GRANT EXECUTE ON FUNCTION finnor_os.x1_assert_effect_current(uuid,text) TO finnor_app;
END IF; END $$;
