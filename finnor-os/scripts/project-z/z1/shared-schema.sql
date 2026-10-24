-- Coordinator-owned integration proposal, not an applied migration.
-- Ordinary exact-derivation storage. No signer, grant, tenant, resource population,
-- protected admission, effect dispatch or business-completion transition.
CREATE TABLE finnor_os.z1_requests(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,id uuid NOT NULL,root jsonb NOT NULL,
 intake jsonb NOT NULL,request jsonb NOT NULL,request_digest text NOT NULL CHECK(request_digest~'^[a-f0-9]{64}$'),
 runtime jsonb NOT NULL,cuts jsonb NOT NULL,rights_revision text NOT NULL,
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),version integer NOT NULL DEFAULT 0 CHECK(version>=0),
 checkpoint jsonb,publication jsonb,deadline_at timestamptz NOT NULL,
 wall_used_ms integer NOT NULL DEFAULT 0 CHECK(wall_used_ms>=0),
 wall_reserved_ms integer NOT NULL DEFAULT 0 CHECK(wall_reserved_ms>=0),
 attempts_used integer NOT NULL DEFAULT 0 CHECK(attempts_used BETWEEN 0 AND 16),
 retained_bytes bigint NOT NULL DEFAULT 0 CHECK(retained_bytes BETWEEN 0 AND 1073741824),
 storage_charged_bytes bigint NOT NULL DEFAULT 0 CHECK(storage_charged_bytes BETWEEN 0 AND retained_bytes),
 event_count integer NOT NULL DEFAULT 0 CHECK(event_count BETWEEN 0 AND 8192),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN
  ('QUEUED','RUNNING','CHECKING','CHECKED_AWAITING_S8','UNKNOWN','INCOMPLETE','UNSUPPORTED','COUNTEREXAMPLE','STALE','REVOKED','INVALIDATED','CANCELLED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 CHECK(wall_used_ms+wall_reserved_ms<=120000),
 CHECK(jsonb_array_length(request->'works') BETWEEN 2 AND 1000),
 CHECK(octet_length(request::text)<=150994944 AND octet_length(intake::text)<=150994944)
);
CREATE TABLE finnor_os.z1_work_episodes(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,request_id uuid NOT NULL,deadline_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,principal_id,work_id),FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.z1_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.z1_intakes(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,idempotency_key text NOT NULL,request_id uuid NOT NULL,
 generation integer NOT NULL CHECK(generation>0),request_digest text NOT NULL,body jsonb NOT NULL,
 PRIMARY KEY(tenant_id,principal_id,idempotency_key),FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.z1_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND octet_length(body::text)<=150994944)
);
CREATE TABLE finnor_os.z1_artifacts(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,request_id uuid NOT NULL,artifact_id text NOT NULL,
 kind text NOT NULL,reference jsonb NOT NULL,body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,artifact_id),FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.z1_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 CHECK(octet_length(body::text)<=150994944 AND reference->>'executionAuthorityGranted' IS NULL)
);
CREATE TABLE finnor_os.z1_attempts(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,id uuid NOT NULL,request_id uuid NOT NULL,generation integer NOT NULL,
 delivery_id uuid NOT NULL,reference jsonb NOT NULL,body jsonb NOT NULL,
 reserved_wall_ms integer NOT NULL CHECK(reserved_wall_ms BETWEEN 1 AND 30000),
 status text NOT NULL DEFAULT 'STARTED' CHECK(status IN('STARTED','FAILED','LOST_UNKNOWN','FINISHED')),
 costs_unknown boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,principal_id,delivery_id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.z1_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(delivery_id) REFERENCES finnor_os.job_delivery_attempts(id),CHECK(octet_length(body::text)<=1048576)
);
CREATE TABLE finnor_os.z1_events(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,id bigint GENERATED ALWAYS AS IDENTITY,
 request_id uuid NOT NULL,attempt_id uuid,event_key text NOT NULL,body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id,event_key),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.z1_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,attempt_id) REFERENCES finnor_os.z1_attempts(tenant_id,id),
 CHECK(length(event_key)<=512 AND octet_length(body::text)<=8388608)
);
CREATE TABLE finnor_os.z1_deliveries(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,request_id uuid NOT NULL,publication_id text NOT NULL,
 work_id uuid NOT NULL,reference jsonb NOT NULL,status text NOT NULL DEFAULT 'PENDING_S8'
 CHECK(status IN('PENDING_S8','CONSUMED')),receipt jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,publication_id,work_id),FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.z1_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,publication_id) REFERENCES finnor_os.z1_artifacts(tenant_id,artifact_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.z1_owner_uses(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,request_id uuid NOT NULL,publication_id text NOT NULL,
 work_id uuid NOT NULL,semantic_owner text NOT NULL CHECK(semantic_owner IN('S3','S4')),reference jsonb NOT NULL,
 body jsonb NOT NULL,receipt jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,publication_id,work_id),FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.z1_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,publication_id) REFERENCES finnor_os.z1_artifacts(tenant_id,artifact_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 CHECK(octet_length(body::text)<=150994944 AND body->>'executionAuthorityGranted'='false'
  AND body->>'businessCompletionGranted'='false')
);
CREATE TABLE finnor_os.s8_z1_shared_work_admissions(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,admission_id text NOT NULL,request_id uuid NOT NULL,
 publication_id text NOT NULL,body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,admission_id),UNIQUE(tenant_id,publication_id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.z1_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,publication_id) REFERENCES finnor_os.z1_artifacts(tenant_id,artifact_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 CHECK(body->>'domain'='Z1_ORIGINAL_EXACT_RELATIONAL_DERIVATION'
  AND body->>'protectionDomain'='DISPOSABLE_LOCAL_DEVELOPMENT'
  AND body->>'executionAuthorityGranted'='false' AND body->>'protectedAdmission'='false'
  AND body->>'productionActivated'='false' AND octet_length(body::text)<=1048576)
);
CREATE INDEX z1_original_work_read ON finnor_os.z1_requests(tenant_id,principal_id,created_at DESC,id DESC);
CREATE INDEX z1_request_events ON finnor_os.z1_events(tenant_id,principal_id,request_id,id);

CREATE FUNCTION finnor_os.z1_progress() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Z1 original responsibility cannot disappear'; END IF;
 IF TG_TABLE_NAME='z1_requests' THEN
  IF to_jsonb(NEW)-ARRAY['intake','request','request_digest','cuts','rights_revision','generation','version','checkpoint',
    'publication','wall_used_ms','wall_reserved_ms','attempts_used','status','retained_bytes','storage_charged_bytes','event_count']
   IS DISTINCT FROM to_jsonb(OLD)-ARRAY['intake','request','request_digest','cuts','rights_revision','generation','version','checkpoint',
    'publication','wall_used_ms','wall_reserved_ms','attempts_used','status','retained_bytes','storage_charged_bytes','event_count']
   OR NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1 OR NEW.version<OLD.version OR NEW.version>OLD.version+1
   OR NEW.wall_used_ms<OLD.wall_used_ms OR NEW.attempts_used<OLD.attempts_used
   OR NEW.retained_bytes<OLD.retained_bytes OR NEW.storage_charged_bytes<OLD.storage_charged_bytes OR NEW.event_count<OLD.event_count
   OR OLD.status='CANCELLED' AND NEW.status<>'CANCELLED'
   OR NEW.request->'identity' IS DISTINCT FROM OLD.request->'identity'
   OR NEW.request->'limits'->>'deadlineAt' IS DISTINCT FROM OLD.request->'limits'->>'deadlineAt'
   OR (SELECT array_agg(w->>'id' ORDER BY w->>'id') FROM jsonb_array_elements(NEW.request->'works') w)
      IS DISTINCT FROM (SELECT array_agg(w->>'id' ORDER BY w->>'id') FROM jsonb_array_elements(OLD.request->'works') w)
  THEN RAISE EXCEPTION 'Z1 original identity, deadline and cumulative occupation cannot reset'; END IF;
  IF NEW.request IS DISTINCT FROM OLD.request AND (NEW.generation<>OLD.generation+1 OR NEW.status<>'QUEUED')
   THEN RAISE EXCEPTION 'Z1 canonical changes require a new fenced generation'; END IF;
 ELSIF TG_TABLE_NAME='z1_attempts' THEN
  IF to_jsonb(NEW)-ARRAY['status','costs_unknown'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','costs_unknown']
   OR OLD.status<>'STARTED' AND NEW.status='STARTED' OR NOT NEW.costs_unknown
  THEN RAISE EXCEPTION 'Z1 physical attempt preimage and unknown tail are retained'; END IF;
 ELSE
  IF to_jsonb(NEW)-ARRAY['status','receipt'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','receipt']
   OR OLD.status='CONSUMED' AND NEW IS DISTINCT FROM OLD
  THEN RAISE EXCEPTION 'Z1 original delivery cannot be rewritten'; END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['z1_requests','z1_work_episodes','z1_intakes','z1_artifacts','z1_attempts',
   'z1_events','z1_deliveries','z1_owner_uses','s8_z1_shared_work_admissions'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY z1_original_principal ON finnor_os.%I
   USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)
   WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  IF t IN('z1_requests','z1_attempts','z1_deliveries') THEN
   EXECUTE format('GRANT UPDATE ON finnor_os.%I TO finnor_app',t);
   EXECUTE format('CREATE TRIGGER z1_progress BEFORE UPDATE OR DELETE ON finnor_os.%I
    FOR EACH ROW EXECUTE FUNCTION finnor_os.z1_progress()',t);
  ELSE
   EXECUTE format('CREATE TRIGGER z1_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I
    FOR EACH ROW EXECUTE FUNCTION finnor_os.s5_immutable_record()',t);
  END IF;
 END LOOP;
END $$;
GRANT USAGE,SELECT ON SEQUENCE finnor_os.z1_events_id_seq TO finnor_app;

-- No new S5 ledger. These scoped writers use existing original reservations,
-- consumption states, conserved resource units and the same tenant serializer.
-- The strict original budget schema has ASCII field names and finite integer
-- JSON numbers. Canonicalize that schema to bind a native authority decision to
-- its exact request, not a caller's asserted digest or a rounded amount.
CREATE FUNCTION finnor_os.z1_budget_json(p jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE
 SET search_path=pg_catalog,finnor_os AS $$
DECLARE result text;
BEGIN
 CASE jsonb_typeof(p)
 WHEN 'object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||finnor_os.z1_budget_json(value),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(p);
 WHEN 'array' THEN SELECT '['||coalesce(string_agg(finnor_os.z1_budget_json(value),',' ORDER BY ordinality),'')||']' INTO result FROM jsonb_array_elements(p) WITH ORDINALITY;
 ELSE result:=p::text;
 END CASE;
 RETURN result;
END $$;
CREATE FUNCTION finnor_os.z1_s5_actor() RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id();u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
 IF t IS NULL OR u IS NULL THEN RAISE EXCEPTION 'Z1 S5 authenticated scope required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('s5-portfolio:'||t::text,0));
 PERFORM 1 FROM finnor_os.users WHERE tenant_id=t AND id=u AND status='active' AND role='owner' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Z1 S5 active original owner required'; END IF;
 PERFORM 1 FROM finnor_os.authority_states WHERE tenant_id=t FOR SHARE;
 RETURN u;
END $$;
CREATE FUNCTION finnor_os.z1_s5_budget(p_id text,p_recovery boolean DEFAULT false) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id();u uuid:=finnor_os.z1_s5_actor();b jsonb;s record;r jsonb;current_resource jsonb;
BEGIN
 SELECT o.body,q.status,q.envelopes,q.revocation_reason INTO s FROM finnor_os.s5_reservation_origins o
  JOIN finnor_os.s5_reservations q USING(tenant_id,reservation_id)
  WHERE o.tenant_id=t AND o.principal_id=u AND o.reservation_id=p_id FOR UPDATE OF q;
 IF NOT FOUND THEN RAISE EXCEPTION 'Z1 S5 owned original parent required'; END IF;
 b:=s.body;
 IF b->>'schema' IS DISTINCT FROM 'finnor.s5.z1-original-budget.v1' OR s.status='RELEASED'
  OR b->'envelopes' IS DISTINCT FROM s.envelopes THEN RAISE EXCEPTION 'Z1 S5 original preimage changed'; END IF;
 IF NOT p_recovery THEN
  IF s.revocation_reason IS NOT NULL OR (b#>>'{original,deadlineAt}')::timestamptz<=clock_timestamp()
   OR b->>'rightsRevision' IS DISTINCT FROM (SELECT revision::text FROM finnor_os.authority_states WHERE tenant_id=t)
   THEN RAISE EXCEPTION 'Z1 S5 original current authority or deadline changed'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(b->'resources') LOOP
   SELECT x.body INTO current_resource FROM finnor_os.s5_resources x
    JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision)
    WHERE x.tenant_id=t AND x.resource_id=r->>'resourceId' FOR SHARE OF h;
   IF current_resource IS DISTINCT FROM r OR (r->>'revoked')::boolean
    THEN RAISE EXCEPTION 'Z1 S5 original resource head changed'; END IF;
  END LOOP;
 END IF;
 RETURN b;
END $$;
CREATE FUNCTION finnor_os.z1_s5_reserve(p_problem jsonb,p_certificate jsonb,p_budget jsonb,p_digest text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id();u uuid:=finnor_os.z1_s5_actor();r jsonb;e jsonb;
 current_resource jsonb;v_deadline timestamptz;v_max numeric;v_used numeric;v_period integer;v_index integer;
 v_available jsonb;v_kind text;v_unit text;v_work uuid;v_prior jsonb;v_row record;v_permission_resources jsonb;v_input jsonb;
BEGIN
 v_work:=(p_budget#>>'{original,workId}')::uuid;v_deadline:=(p_budget#>>'{original,deadlineAt}')::timestamptz;
 IF (p_problem->>'schema' IS DISTINCT FROM 'finnor.s5.z1-original-work-problem.v1'
  OR p_certificate->>'schema' IS DISTINCT FROM 'finnor.s5.z1-original-work-certificate.v1'
  OR p_budget->>'schema' IS DISTINCT FROM 'finnor.s5.z1-original-budget.v1'
  OR p_budget->>'tenantId' IS DISTINCT FROM t::text OR p_budget->>'principalId' IS DISTINCT FROM u::text
  OR p_certificate->>'tenantId' IS DISTINCT FROM t::text OR p_certificate->>'principalId' IS DISTINCT FROM u::text
  OR p_budget->'original' IS DISTINCT FROM p_problem->'original'
  OR p_digest IS DISTINCT FROM encode(sha256(convert_to(finnor_os.z1_budget_json(p_budget->'original'),'UTF8')),'hex')
  OR p_budget->'resources' IS DISTINCT FROM p_problem->'resources'
  OR p_budget->'certificateRef' IS DISTINCT FROM p_certificate->'ref'
  OR p_budget->'envelopes' IS DISTINCT FROM p_certificate#>'{check,envelopes}'
  OR p_budget->>'rightsRevision' IS DISTINCT FROM (SELECT revision::text FROM finnor_os.authority_states WHERE tenant_id=t)
  OR p_budget->>'executionAuthorityGranted' IS DISTINCT FROM 'false' OR p_budget->'protectedReceipt' IS DISTINCT FROM 'null'::jsonb
  OR p_certificate->>'executionAuthorityGranted' IS DISTINCT FROM 'false'
  OR jsonb_array_length(p_budget->'resources')<>4 OR jsonb_array_length(p_budget->'envelopes')<>4
  OR v_deadline<=clock_timestamp() OR v_deadline>clock_timestamp()+interval '24 hours'
  OR jsonb_array_length(p_budget->'resourceReadDecisionIds')<>4
  OR p_budget->'ref'->>'owner' IS DISTINCT FROM 'S5' OR p_certificate->'ref'->>'owner' IS DISTINCT FROM 'S5'
  OR p_budget->'ref'->>'version' IS DISTINCT FROM 'z1-native-owner-v1'
  OR p_certificate->'ref'->>'version' IS DISTINCT FROM 'z1-native-owner-v1'
  OR p_budget->'ref'->>'contentDigest' !~ '^[a-f0-9]{64}$'
  OR p_certificate->'ref'->>'contentDigest' !~ '^[a-f0-9]{64}$'
  OR p_budget->'ref'->>'contentDigest' IS DISTINCT FROM
   encode(sha256(convert_to(finnor_os.z1_budget_json(p_budget-'ref'),'UTF8')),'hex')
  OR p_certificate->'ref'->>'contentDigest' IS DISTINCT FROM
   encode(sha256(convert_to(finnor_os.z1_budget_json(p_certificate-'ref'),'UTF8')),'hex')
  OR p_budget->'ref'->>'id' IS DISTINCT FROM 'z1-original-budget:'||(p_budget->'ref'->>'contentDigest')
  OR p_certificate->'ref'->>'id' IS DISTINCT FROM 'z1-original-certificate:'||(p_certificate->'ref'->>'contentDigest')
  OR p_digest !~ '^[a-f0-9]{64}$' OR octet_length(p_problem::text)+octet_length(p_certificate::text)>8388608
  OR octet_length(p_budget::text)>8388608
 ) IS DISTINCT FROM false THEN RAISE EXCEPTION 'Z1 S5 exact original budget domain required'; END IF;
 PERFORM 1 FROM finnor_os.works WHERE tenant_id=t AND id=v_work AND created_by=u
  AND status NOT IN('completed','failed','cancelled') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Z1 S5 current original Work required';END IF;
 SELECT to_jsonb(i) INTO v_input FROM finnor_os.work_inputs i WHERE i.tenant_id=t AND i.work_id=v_work
  ORDER BY created_at DESC,id DESC LIMIT 1;
 IF (v_input->>'id' IS DISTINCT FROM p_budget->>'inputId'
  OR v_input#>'{context_snapshot,businessRoot}' IS DISTINCT FROM p_budget#>'{original,root}'
  OR p_budget->>'inputDigest' IS DISTINCT FROM
   encode(sha256(convert_to(finnor_os.z1_budget_json(v_input),'UTF8')),'hex')
  OR p_problem->'input' IS DISTINCT FROM jsonb_build_object('inputId',p_budget->>'inputId','inputDigest',p_budget->>'inputDigest')
  OR p_problem->>'originalWorkId' IS DISTINCT FROM v_work::text
  OR p_certificate->>'originalWorkId' IS DISTINCT FROM v_work::text
  OR p_certificate->>'rightsRef' IS DISTINCT FROM p_budget->>'rightsRevision'
  OR p_certificate->'policyBindings' IS DISTINCT FROM '[]'::jsonb
  OR p_certificate->'protectedReceipt' IS DISTINCT FROM 'null'::jsonb
  OR p_certificate#>>'{check,feasible}' IS DISTINCT FROM 'true'
  OR p_certificate->>'validUntil' IS DISTINCT FROM p_budget#>>'{original,deadlineAt}'
 ) IS DISTINCT FROM false THEN RAISE EXCEPTION 'Z1 S5 exact current original input and certificate required';END IF;
 SELECT jsonb_agg(jsonb_build_object('type','allocation_resource','id',scope_id) ORDER BY ordinal) INTO v_permission_resources
  FROM (SELECT r->'scopeRef'->>'id' scope_id,min(ordinality) ordinal
    FROM jsonb_array_elements(p_budget->'resources') WITH ORDINALITY a(r,ordinality)
    GROUP BY r->'scopeRef'->>'id') q;
 PERFORM 1 FROM finnor_os.authority_decisions a WHERE a.tenant_id=t AND a.employee_id=u
  AND a.id=(p_budget->>'authorityDecisionId')::uuid AND a.authority_revision=(p_budget->>'rightsRevision')::integer
  AND a.operation='action' AND a.capability='action:allocate_resource' AND a.outcome='allowed'
  AND a.reason_code='grant_allows' AND a.risk='high' AND a.work_id=v_work
  AND a.created_at>clock_timestamp()-interval '30 seconds' AND a.created_at<=clock_timestamp()
  AND a.evidence->'resources'=v_permission_resources AND a.evidence->>'exactAmountUsd'='0'
  AND a.evidence#>>'{controlBinding,proposalId}'=v_work::text
  AND a.evidence#>>'{controlBinding,proposalDigest}'=p_digest
  AND a.evidence#>>'{controlBinding,requestDigest}'=p_digest
  AND a.evidence#>>'{controlBinding,dependencyDigest}'=
   encode(sha256(convert_to(finnor_os.z1_budget_json(jsonb_build_object(
    'cut',p_problem->'input','resources',p_budget#>'{original,resources}','rights',p_budget->>'rightsRevision')),'UTF8')),'hex')
  AND a.evidence#>>'{controlBinding,expiresAt}'=p_budget#>>'{original,deadlineAt}' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Z1 S5 fresh exact canonical allocation authority required';END IF;
 SELECT o.body INTO v_prior FROM finnor_os.s5_reservation_origins o JOIN finnor_os.s5_proposals p
  ON p.tenant_id=o.tenant_id AND p.content_digest=o.allocation_digest
  WHERE o.tenant_id=t AND o.principal_id=u AND p.problem->>'schema'='finnor.s5.z1-original-work-problem.v1'
  AND p.problem->>'originalWorkId'=v_work::text;
 IF FOUND THEN
  IF v_prior IS DISTINCT FROM p_budget THEN RAISE EXCEPTION 'Z1 S5 original parent cannot renew'; END IF;
  RETURN finnor_os.z1_s5_budget(v_prior->'ref'->>'id');
 END IF;
 IF NOT finnor_os.y4_allocation_context_complete() OR
  (SELECT count(*) FROM finnor_os.s5_reservations WHERE tenant_id=t AND status<>'RELEASED')>=256
  THEN RAISE EXCEPTION 'Z1 S5 complete bounded shared portfolio required'; END IF;
 FOR v_index IN 0..3 LOOP
  r:=p_budget->'resources'->v_index;e:=p_budget->'envelopes'->v_index;
  v_kind:=CASE WHEN v_index=3 THEN 'OCCUPANCY' ELSE 'CUMULATIVE_EXPENDITURE' END;
  v_unit:=CASE WHEN v_index=0 THEN 'z1-logical-tick' WHEN v_index=1 THEN 'cpu-microseconds' ELSE 'byte' END;
  v_max:=CASE v_index WHEN 0 THEN (p_budget#>>'{original,maximumTicks}')::numeric
   WHEN 1 THEN (p_budget#>>'{original,maximumCpuMicros}')::numeric
   WHEN 2 THEN (p_budget#>>'{original,maximumRetainedBytes}')::numeric
   ELSE (p_budget#>>'{original,maximumMemoryBytes}')::numeric END;
  IF (v_max<=0 OR v_max<>trunc(v_max) OR v_max>CASE v_index WHEN 0 THEN 1000000000 WHEN 1 THEN 120000000
   WHEN 2 THEN 536870912 ELSE 2147483648 END) IS DISTINCT FROM false
   THEN RAISE EXCEPTION 'Z1 S5 original finite resource bound required'; END IF;
  SELECT x.body INTO current_resource FROM finnor_os.s5_resources x
   JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision)
   WHERE x.tenant_id=t AND x.resource_id=r->>'resourceId' FOR SHARE OF h;
  IF (current_resource IS DISTINCT FROM r OR r->>'resourceClass'<>'COMPUTE' OR r->>'unit'<>v_unit
   OR r->>'kind'<>v_kind OR r->'currency'<>'null'::jsonb OR r->'ownerRef'->>'id'<>u::text
   OR r->'revoked'<>'false'::jsonb OR jsonb_array_length(r->'covenants')<>0
   OR NOT r->'permittedRoots' @> jsonb_build_array(p_budget#>'{original,root}')
   OR (r->>'validUntil')::timestamptz<v_deadline
   OR (r#>>'{horizon,startAt}')::timestamptz>clock_timestamp()
   OR (r#>>'{horizon,startAt}')::timestamptz+
    ((r#>>'{horizon,periodMs}')::numeric*(r#>>'{horizon,periods}')::integer)*interval '1 millisecond'<v_deadline
   OR e->>'resourceId'<>r->>'resourceId' OR e->>'kind'<>v_kind OR e->>'unit'<>v_unit
   OR e->'horizon' IS DISTINCT FROM r->'horizon'
   OR (r#>>'{horizon,periods}')::integer NOT BETWEEN 1 AND 64
   OR (r#>>'{horizon,periodMs}')::numeric<=0
   OR jsonb_array_length(e->'quantities')<>(r#>>'{horizon,periods}')::integer+1
   OR jsonb_array_length(e->'minimumQuantities')<>(r#>>'{horizon,periods}')::integer+1
   OR jsonb_array_length(r->'existingUse')<>(r#>>'{horizon,periods}')::integer+1
   OR jsonb_array_length(r->'availability')<>(r#>>'{horizon,periods}')::integer+1
   OR r->>'safetyMargin' !~ '^(0|[1-9][0-9]{0,15})$'
   ) IS DISTINCT FROM false THEN RAISE EXCEPTION 'Z1 S5 current original resource domain changed'; END IF;
  PERFORM 1 FROM finnor_os.authority_decisions a WHERE a.tenant_id=t AND a.employee_id=u
   AND a.id=(p_budget->'resourceReadDecisionIds'->>v_index)::uuid
   AND a.authority_revision=(p_budget->>'rightsRevision')::integer
   AND a.operation='query' AND a.capability='query:allocation_resources' AND a.risk='low'
   AND a.outcome='allowed' AND a.reason_code='grant_allows'
   AND a.created_at>clock_timestamp()-interval '30 seconds' AND a.created_at<=clock_timestamp()
   AND a.evidence->'resources'=jsonb_build_array(jsonb_build_object('type','allocation_resource','id',r->'scopeRef'->>'id'))
   FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Z1 S5 fresh exact resource read authority required';END IF;
  FOR v_period IN 0..(r#>>'{horizon,periods}')::integer LOOP
   IF e->'quantities'->>v_period IS DISTINCT FROM (CASE WHEN v_index=3 OR v_period=0 THEN v_max::text ELSE '0' END)
    OR e->'minimumQuantities'->>v_period IS DISTINCT FROM '0'
    OR (r->'existingUse'->>v_period ~ '^(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true
    THEN RAISE EXCEPTION 'Z1 S5 exact original resource envelope required'; END IF;
   v_available:=r->'availability'->v_period;
   IF v_available->>'basis' IS DISTINCT FROM 'REPORTED_AVAILABLE'
    OR (v_available->>'amount' ~ '^(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true
    THEN RAISE EXCEPTION 'Z1 S5 capacity is unknown'; END IF;
   SELECT coalesce(sum(value::numeric),0) INTO v_used FROM jsonb_array_elements_text(r->'existingUse') WITH ORDINALITY
    WHERE CASE WHEN v_index=3 THEN ordinality=v_period+1 ELSE ordinality<=v_period+1 END;
   FOR v_row IN SELECT held.value env FROM finnor_os.s5_reservations s
    CROSS JOIN LATERAL jsonb_array_elements(s.envelopes) held
    WHERE s.tenant_id=t AND s.status<>'RELEASED' AND held.value->>'resourceId'=r->>'resourceId' LOOP
    IF v_row.env->'horizon' IS DISTINCT FROM r->'horizon' OR v_row.env->>'kind'<>v_kind OR v_row.env->>'unit'<>v_unit
     THEN RAISE EXCEPTION 'Z1 S5 complete common resource horizon required'; END IF;
    SELECT v_used+coalesce(sum(value::numeric),0) INTO v_used
     FROM jsonb_array_elements_text(v_row.env->'quantities') WITH ORDINALITY
     WHERE CASE WHEN v_index=3 THEN ordinality=v_period+1 ELSE ordinality<=v_period+1 END;
   END LOOP;
   IF v_used+v_max>(v_available->>'amount')::numeric-(r->>'safetyMargin')::numeric
    THEN RAISE EXCEPTION 'Z1 S5 shared portfolio exhausted'; END IF;
  END LOOP;
 END LOOP;
 INSERT INTO finnor_os.s5_proposals(tenant_id,principal_id,content_digest,problem,certificate)
  VALUES(t,u,p_certificate->'ref'->>'contentDigest',p_problem,p_certificate);
 INSERT INTO finnor_os.s5_requests(tenant_id,principal_id,idempotency_key,request_digest,allocation_digest)
  VALUES(t,u,'z1-original:'||v_work::text,p_digest,p_certificate->'ref'->>'contentDigest');
 INSERT INTO finnor_os.s5_reservation_origins(tenant_id,principal_id,reservation_id,allocation_digest,body)
  VALUES(t,u,p_budget->'ref'->>'id',p_certificate->'ref'->>'contentDigest',p_budget);
 INSERT INTO finnor_os.s5_reservations(tenant_id,reservation_id,allocation_digest,revision,status,envelopes)
  VALUES(t,p_budget->'ref'->>'id',p_certificate->'ref'->>'contentDigest',1,'RESERVED',p_budget->'envelopes');
 RETURN p_budget;
END $$;

CREATE FUNCTION finnor_os.z1_s5_hold_cpu(p_record jsonb,p_key text,p_digest text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id();u uuid:=finnor_os.z1_s5_actor();b jsonb;
 v_parent text:=p_record->'parentReservationRef'->>'id';v_used bigint;v_pending bigint;v_prior record;
BEGIN
 b:=finnor_os.z1_s5_budget(v_parent);
 IF (p_record->>'schema' IS DISTINCT FROM 'finnor.s5.z1-compute-hold.v1'
  OR p_record->>'tenantId' IS DISTINCT FROM t::text OR p_record->>'principalId' IS DISTINCT FROM u::text
  OR p_record->'parentReservationRef' IS DISTINCT FROM b->'ref'
  OR p_record->>'originalWorkId' IS DISTINCT FROM b#>>'{original,workId}'
  OR p_record->>'originalDeadline' IS DISTINCT FROM b#>>'{original,deadlineAt}'
  OR p_record->>'requestDigest' IS DISTINCT FROM p_digest
  OR (p_record->>'maximumUnits')::bigint NOT BETWEEN 1 AND 120000000
  OR p_record->>'executionAuthorityGranted' IS DISTINCT FROM 'false'
  OR p_record->'ref'->>'owner' IS DISTINCT FROM 'S5'
  OR p_record->'ref'->>'contentDigest' !~ '^[a-f0-9]{64}$'
  OR p_record->'ref'->>'id' IS DISTINCT FROM 'z1-compute-hold:'||(p_record->'ref'->>'contentDigest')
  OR p_digest !~ '^[a-f0-9]{64}$' OR length(p_key)>256 OR octet_length(p_record::text)>8388608
  ) IS DISTINCT FROM false THEN RAISE EXCEPTION 'Z1 S5 exact bounded original CPU hold required'; END IF;
 SELECT request_digest INTO v_prior FROM finnor_os.s5_consumptions
  WHERE tenant_id=t AND principal_id=u AND idempotency_key=p_key;
 IF FOUND THEN IF v_prior.request_digest<>p_digest THEN RAISE EXCEPTION 'Z1 S5 CPU hold idempotency conflict'; END IF;RETURN;END IF;
 SELECT coalesce(sum(units),0) INTO v_used FROM finnor_os.s5_governed_resource_charges
  WHERE tenant_id=t AND reservation_id=v_parent AND resource_id=b->'resources'->1->>'resourceId';
 SELECT coalesce(sum((co.body->>'maximumUnits')::bigint),0) INTO v_pending FROM finnor_os.s5_consumptions co
  JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
  WHERE co.tenant_id=t AND co.reservation_id=v_parent AND co.body->>'schema'='finnor.s5.z1-compute-hold.v1'
   AND st.status<>'RECONCILED';
 IF v_used+v_pending+(p_record->>'maximumUnits')::bigint>(b#>>'{original,maximumCpuMicros}')::bigint
  THEN RAISE EXCEPTION 'Z1 S5 original pending and spent CPU exhausted'; END IF;
 INSERT INTO finnor_os.s5_consumptions(tenant_id,principal_id,consumption_id,reservation_id,policy_id,node_id,idempotency_key,request_digest,body)
  VALUES(t,u,p_record->'ref'->>'id',v_parent,'original-work:'||(b#>>'{original,workId}'),'cpu-hold:'||(p_record->>'key'),p_key,p_digest,p_record);
 INSERT INTO finnor_os.s5_consumption_states(tenant_id,consumption_id,status,revision)
  VALUES(t,p_record->'ref'->>'id','INTENDED_PENDING_S6',1);
END $$;

CREATE FUNCTION finnor_os.z1_s5_charge(p_record jsonb,p_key text,p_node text,p_hold jsonb,p_recovery boolean)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id();u uuid:=finnor_os.z1_s5_actor();b jsonb;r jsonb;
 v_parent text:=p_record->'reservationRef'->>'id';v_units bigint:=(p_record->>'units')::bigint;
 v_used bigint;v_pending bigint;v_max bigint;v_role text:=p_record->>'role';v_index integer;
 v_left bigint;v_ordinal integer:=0;v_part bigint;v_prior record;v_hold jsonb;
BEGIN
 b:=finnor_os.z1_s5_budget(v_parent,p_recovery);
 v_index:=CASE v_role WHEN 'logical' THEN 0 WHEN 'cpu' THEN 1 WHEN 'storage' THEN 2 ELSE NULL END;
 r:=b->'resources'->v_index;
 v_max:=CASE v_role WHEN 'logical' THEN (b#>>'{original,maximumTicks}')::bigint
  WHEN 'cpu' THEN (b#>>'{original,maximumCpuMicros}')::bigint WHEN 'storage' THEN (b#>>'{original,maximumRetainedBytes}')::bigint END;
 IF (v_index IS NULL OR v_units NOT BETWEEN 0 AND 1000000000
  OR p_record->>'schema' IS DISTINCT FROM 'finnor.s5.z1-original-consumption.v1'
  OR p_record->>'tenantId' IS DISTINCT FROM t::text OR p_record->>'principalId' IS DISTINCT FROM u::text
  OR p_record->'reservationRef' IS DISTINCT FROM b->'ref' OR p_record->'resourceRef' IS DISTINCT FROM r->'ref'
  OR p_record->>'originalWorkId' IS DISTINCT FROM b#>>'{original,workId}'
  OR p_record->>'originalDeadline' IS DISTINCT FROM b#>>'{original,deadlineAt}'
  OR p_record->>'chargeKey' IS DISTINCT FROM p_key OR p_record->>'executionAuthorityGranted' IS DISTINCT FROM 'false'
  OR p_record->'ref'->>'owner' IS DISTINCT FROM 'S5'
  OR p_record->'ref'->>'contentDigest' !~ '^[a-f0-9]{64}$'
  OR p_record->'ref'->>'id' IS DISTINCT FROM 'z1-original-consumption:'||(p_record->'ref'->>'contentDigest')
  OR p_record->>'requestDigest' !~ '^[a-f0-9]{64}$' OR length(p_key)>256 OR length(p_node)>512
  OR octet_length(p_record::text)>8388608
  ) IS DISTINCT FROM false THEN RAISE EXCEPTION 'Z1 S5 exact original charge domain required'; END IF;
 SELECT request_digest INTO v_prior FROM finnor_os.s5_consumptions
  WHERE tenant_id=t AND principal_id=u AND idempotency_key=p_key;
 IF FOUND THEN
  IF v_prior.request_digest<>p_record->>'requestDigest' THEN RAISE EXCEPTION 'Z1 S5 charge idempotency conflict'; END IF;RETURN;
 END IF;
 IF p_hold IS NOT NULL THEN
  SELECT co.body INTO v_hold FROM finnor_os.s5_consumptions co
   JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
   WHERE co.tenant_id=t AND co.principal_id=u AND co.reservation_id=v_parent
    AND co.consumption_id=p_hold->>'id' AND st.status='INTENDED_PENDING_S6' FOR UPDATE OF st;
  IF v_role<>'cpu' OR v_hold IS NULL OR v_hold->'ref' IS DISTINCT FROM p_hold
   OR v_hold->>'schema'<>'finnor.s5.z1-compute-hold.v1' OR v_units>(v_hold->>'maximumUnits')::bigint
   THEN RAISE EXCEPTION 'Z1 S5 exact unsettled owned CPU hold required'; END IF;
 END IF;
 SELECT coalesce(sum(units),0) INTO v_used FROM finnor_os.s5_governed_resource_charges
  WHERE tenant_id=t AND reservation_id=v_parent AND resource_id=r->>'resourceId';
 v_pending:=0;
 IF v_role='cpu' THEN
  SELECT coalesce(sum((co.body->>'maximumUnits')::bigint),0) INTO v_pending FROM finnor_os.s5_consumptions co
   JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
   WHERE co.tenant_id=t AND co.reservation_id=v_parent AND co.body->>'schema'='finnor.s5.z1-compute-hold.v1'
    AND st.status<>'RECONCILED' AND (p_hold IS NULL OR co.consumption_id<>p_hold->>'id');
 END IF;
 IF v_used+v_pending+v_units>v_max THEN RAISE EXCEPTION 'Z1 S5 original remaining resource exhausted'; END IF;
 INSERT INTO finnor_os.s5_consumptions(tenant_id,principal_id,consumption_id,reservation_id,policy_id,node_id,idempotency_key,request_digest,body)
  VALUES(t,u,p_record->'ref'->>'id',v_parent,'original-work:'||(b#>>'{original,workId}'),p_node,p_key,p_record->>'requestDigest',p_record);
 INSERT INTO finnor_os.s5_consumption_states(tenant_id,consumption_id,status,revision)
  VALUES(t,p_record->'ref'->>'id','RECONCILED',1);
 v_left:=v_units;
 WHILE v_left>0 LOOP
  v_part:=least(v_left,100000);v_left:=v_left-v_part;
  INSERT INTO finnor_os.s5_governed_resource_charges
   (tenant_id,principal_id,reservation_id,consumption_id,charge_key,phase,resource_id,unit,units,request_digest,body)
   VALUES(t,u,v_parent,p_record->'ref'->>'id',p_key||':'||v_ordinal::text,'EXECUTION',r->>'resourceId',r->>'unit',v_part,p_record->>'requestDigest',p_record);
  v_ordinal:=v_ordinal+1;
 END LOOP;
 UPDATE finnor_os.s5_reservations SET status='CONSUMPTION_PENDING',revision=revision+1
  WHERE tenant_id=t AND reservation_id=v_parent AND status='RESERVED';
 IF p_hold IS NOT NULL THEN UPDATE finnor_os.s5_consumption_states SET status='RECONCILED',revision=revision+1
  WHERE tenant_id=t AND consumption_id=p_hold->>'id' AND status='INTENDED_PENDING_S6';END IF;
END $$;

-- Typed Z1 origins cannot be inserted or altered through ordinary table grants.
CREATE FUNCTION finnor_os.z1_s5_writer_guard() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,finnor_os AS $$
DECLARE body jsonb;is_z1 boolean;
BEGIN
 body:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME='s5_proposals' THEN is_z1:=body->'problem'->>'schema'='finnor.s5.z1-original-work-problem.v1';
 ELSE
  SELECT o.body->>'schema'='finnor.s5.z1-original-budget.v1' INTO is_z1 FROM finnor_os.s5_reservation_origins o
   WHERE o.tenant_id=(body->>'tenant_id')::uuid AND o.reservation_id=body->>'reservation_id';
  IF TG_TABLE_NAME='s5_reservation_origins' THEN is_z1:=body->'body'->>'schema'='finnor.s5.z1-original-budget.v1';END IF;
  IF TG_TABLE_NAME='s5_consumption_states' THEN
   SELECT o.body->>'schema'='finnor.s5.z1-original-budget.v1' INTO is_z1 FROM finnor_os.s5_consumptions c
    JOIN finnor_os.s5_reservation_origins o USING(tenant_id,reservation_id)
    WHERE c.tenant_id=(body->>'tenant_id')::uuid AND c.consumption_id=body->>'consumption_id';
  END IF;
 END IF;
 IF coalesce(is_z1,false) AND current_user<>pg_get_userbyid(
  (SELECT relowner FROM pg_class WHERE oid='finnor_os.s5_reservations'::regclass))
  THEN RAISE EXCEPTION 'Z1 S5 typed lifecycle requires canonical owner writer';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['s5_proposals','s5_reservation_origins','s5_reservations','s5_consumptions',
  's5_consumption_states','s5_governed_resource_charges'] LOOP
  EXECUTE format('CREATE TRIGGER z1_s5_owner_writer BEFORE INSERT OR UPDATE OR DELETE ON finnor_os.%I
   FOR EACH ROW EXECUTE FUNCTION finnor_os.z1_s5_writer_guard()',t);
 END LOOP;
END $$;
CREATE FUNCTION finnor_os.z1_s5_visible(p_subject text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,finnor_os AS $$
 SELECT NOT EXISTS(SELECT 1 FROM finnor_os.s5_reservation_origins o LEFT JOIN finnor_os.s5_consumptions c USING(tenant_id,reservation_id)
  WHERE o.tenant_id=finnor_os.request_tenant_id() AND o.body->>'schema'='finnor.s5.z1-original-budget.v1'
  AND (o.reservation_id=p_subject OR c.consumption_id=p_subject)
  AND o.principal_id IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid)
$$;
CREATE POLICY z1_s5_proposal_privacy ON finnor_os.s5_proposals AS RESTRICTIVE FOR SELECT
 USING(current_user<>'finnor_app' OR problem->>'schema' IS DISTINCT FROM 'finnor.s5.z1-original-work-problem.v1'
  OR principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY z1_s5_origin_privacy ON finnor_os.s5_reservation_origins AS RESTRICTIVE FOR SELECT
 USING(current_user<>'finnor_app' OR body->>'schema'<>'finnor.s5.z1-original-budget.v1'
  OR principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
DO $$ DECLARE t text;column_name text;BEGIN
 FOREACH t IN ARRAY ARRAY['s5_reservations','s5_consumptions','s5_consumption_states','s5_governed_resource_charges','s5_history'] LOOP
  column_name:=CASE WHEN t='s5_history' THEN 'subject_id' WHEN t='s5_consumption_states' THEN 'consumption_id' ELSE 'reservation_id' END;
  EXECUTE format('CREATE POLICY z1_s5_subject_privacy ON finnor_os.%I AS RESTRICTIVE FOR SELECT
   USING(current_user<>''finnor_app'' OR finnor_os.z1_s5_visible(%I))',t,column_name);
 END LOOP;
END $$;
CREATE FUNCTION finnor_os.z1_s5_outstanding()
 RETURNS TABLE(reservation_ref jsonb,certificate_ref jsonb,envelopes jsonb,status text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE u uuid:=finnor_os.z1_s5_actor();
BEGIN
 RETURN QUERY SELECT o.body->'ref',o.body->'certificateRef',s.envelopes,s.status
  FROM finnor_os.s5_reservations s JOIN finnor_os.s5_reservation_origins o USING(tenant_id,reservation_id)
  WHERE s.tenant_id=finnor_os.request_tenant_id() AND s.status<>'RELEASED'
   AND o.body->>'schema'='finnor.s5.z1-original-budget.v1' ORDER BY s.reservation_id LIMIT 257;
END $$;

-- Native JSON write occupation, including repeated checkpoint/publication bodies.
-- This is not disk blocks, WAL, indices, compaction, billing or money. Those
-- physical scopes remain UNKNOWN and cannot qualify an equipped comparison.
CREATE FUNCTION finnor_os.z1_storage_meter() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,finnor_os AS $$
DECLARE v_id uuid;v_size bigint;v_episode finnor_os.z1_requests;
BEGIN
 IF TG_TABLE_NAME='z1_requests' AND TG_OP='UPDATE'
  AND to_jsonb(NEW)-ARRAY['retained_bytes','storage_charged_bytes','event_count']
   IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY['retained_bytes','storage_charged_bytes','event_count']
  THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='z1_requests' THEN v_id:=NEW.id;ELSE v_id:=NEW.request_id;END IF;
 v_size:=octet_length(to_jsonb(NEW)::text);
 UPDATE finnor_os.z1_requests SET retained_bytes=retained_bytes+v_size,
  event_count=event_count+CASE WHEN TG_TABLE_NAME='z1_events' THEN 1 ELSE 0 END
  WHERE tenant_id=NEW.tenant_id AND id=v_id RETURNING * INTO v_episode;
 IF NOT FOUND THEN RAISE EXCEPTION 'Z1 original storage episode required';END IF;
 RETURN NEW;
END $$;

-- Lock parent identities, not just a previously latest version. An append cannot
-- slip between a current-head read and the original owner transaction's commit.
CREATE FUNCTION finnor_os.z1_lock_source_cut(p_source uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id();u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
 IF t IS NULL OR u IS NULL OR NOT EXISTS(SELECT 1 FROM finnor_os.users
  WHERE tenant_id=t AND id=u AND status='active' AND role='owner') THEN RAISE EXCEPTION 'Z1 original source owner required';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('z1-source-authority:'||t::text,0));
 PERFORM 1 FROM finnor_os.evidence_sources WHERE tenant_id=t AND id=p_source FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Z1 canonical tenant source required';END IF;
END $$;
CREATE FUNCTION finnor_os.z1_source_parent_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_TABLE_NAME='work_inputs' THEN
  PERFORM 1 FROM finnor_os.works WHERE tenant_id=NEW.tenant_id AND id=NEW.work_id FOR UPDATE;
 ELSE
  PERFORM 1 FROM finnor_os.evidence_sources WHERE tenant_id=NEW.tenant_id AND id=NEW.source_id FOR UPDATE;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER z1_work_parent_fence BEFORE INSERT ON finnor_os.work_inputs FOR EACH ROW EXECUTE FUNCTION finnor_os.z1_source_parent_fence();
CREATE TRIGGER z1_s1_parent_fence BEFORE INSERT ON finnor_os.evidence_source_versions FOR EACH ROW EXECUTE FUNCTION finnor_os.z1_source_parent_fence();
CREATE FUNCTION finnor_os.z1_source_authority_fence() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('z1-source-authority:'||t::text,0));
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER z1_scope_authority_fence BEFORE INSERT OR UPDATE OR DELETE ON finnor_os.integration_source_scopes
 FOR EACH ROW EXECUTE FUNCTION finnor_os.z1_source_authority_fence();
CREATE TRIGGER z1_observation_scope_fence BEFORE INSERT OR UPDATE OR DELETE ON finnor_os.external_ref_observations
 FOR EACH ROW EXECUTE FUNCTION finnor_os.z1_source_authority_fence();
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['z1_requests','z1_work_episodes','z1_intakes','z1_artifacts','z1_attempts',
  'z1_events','z1_deliveries','z1_owner_uses','s8_z1_shared_work_admissions'] LOOP
  EXECUTE format('CREATE TRIGGER z1_native_storage AFTER INSERT OR UPDATE ON finnor_os.%I
   FOR EACH ROW EXECUTE FUNCTION finnor_os.z1_storage_meter()',t);
 END LOOP;
END $$;

-- Source-owner commits serialize against the same request row as publication and
-- consumption. A signed change may create a new generation with the old parents.
CREATE FUNCTION finnor_os.z1_original_cut_changed() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_TABLE_NAME='work_inputs' THEN
  UPDATE finnor_os.z1_requests q SET status='INVALIDATED'
   WHERE q.tenant_id=NEW.tenant_id AND q.status NOT IN('CANCELLED','INVALIDATED')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.cuts) c WHERE c->>'workId'=NEW.work_id::text AND c->>'inputId'<>NEW.id::text);
 ELSIF TG_TABLE_NAME='evidence_source_versions' THEN
  UPDATE finnor_os.z1_requests q SET status='INVALIDATED'
   WHERE q.tenant_id=NEW.tenant_id AND q.status NOT IN('CANCELLED','INVALIDATED')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.cuts) c WHERE
    c->'declaration'->>'sourceId'=NEW.source_id::text AND c->'declaration'->>'versionId'<>NEW.id::text
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(c->'sourcePins') p WHERE p->>'sourceId'=NEW.source_id::text AND p->>'versionId'<>NEW.id::text));
 ELSE
  UPDATE finnor_os.z1_requests SET status='INVALIDATED'
   WHERE tenant_id=NEW.tenant_id AND status NOT IN('CANCELLED','INVALIDATED');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER z1_work_input_changed AFTER INSERT ON finnor_os.work_inputs FOR EACH ROW EXECUTE FUNCTION finnor_os.z1_original_cut_changed();
CREATE TRIGGER z1_s1_source_changed AFTER INSERT ON finnor_os.evidence_source_versions FOR EACH ROW EXECUTE FUNCTION finnor_os.z1_original_cut_changed();
CREATE TRIGGER z1_authority_changed AFTER UPDATE ON finnor_os.authority_states FOR EACH ROW EXECUTE FUNCTION finnor_os.z1_original_cut_changed();
CREATE TRIGGER z1_source_scope_changed AFTER UPDATE ON finnor_os.integration_source_scopes FOR EACH ROW EXECUTE FUNCTION finnor_os.z1_original_cut_changed();

-- Trusted fixed classification and a single shared provider slot. These are
-- policy declarations only, not resource population, provisioning or activation.
INSERT INTO finnor_os.compute_job_type_policies
 (job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES
 ('run_shared_work_program_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
  'Z1 bounded exact shared programme and independent original-Work checking under immutable original budgets; no effect or protected authority.'),
 ('consume_shared_work_projection_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
  'Z1 admitted exact original projection consumed by the actual original S3/S4 owner; canonical claim fencing, no executable handoff.');
INSERT INTO finnor_os.compute_resource_policies
 (resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
 VALUES('provider:z1-shared-work-native',1,1,0,90,
  'One Z1 bounded producer/checker or original-owner stack, preserving the shared canonical compute serializer');

-- No PUBLIC writer/definer capability. These grants are a coordinator-reviewed
-- migration proposal only; this file has never been executed by this phase.
REVOKE ALL ON FUNCTION finnor_os.z1_s5_actor() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.z1_budget_json(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.z1_s5_budget(text,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.z1_s5_reserve(jsonb,jsonb,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.z1_s5_hold_cpu(jsonb,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.z1_s5_charge(jsonb,text,text,jsonb,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.z1_s5_visible(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.z1_s5_outstanding() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.z1_lock_source_cut(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.z1_s5_actor(),finnor_os.z1_s5_budget(text,boolean),
 finnor_os.z1_s5_reserve(jsonb,jsonb,jsonb,text),finnor_os.z1_s5_hold_cpu(jsonb,text,text),
 finnor_os.z1_s5_charge(jsonb,text,text,jsonb,boolean),finnor_os.z1_s5_visible(text),finnor_os.z1_s5_outstanding(),
 finnor_os.z1_lock_source_cut(uuid) TO finnor_app;
