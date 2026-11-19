-- W5 stores checked proposals and transition links. Work, S1 evidence, S5
-- reservations, S6 effects and S7 accounting retain their original owners.
CREATE TABLE finnor_os.w5_requests(
 tenant_id uuid NOT NULL,id uuid NOT NULL,principal_id uuid NOT NULL,company_id uuid NOT NULL,
 work_id uuid NOT NULL,work_input_id uuid NOT NULL,idempotency_key text NOT NULL,
 request_digest text NOT NULL,original_digest text NOT NULL,original_input_digest text NOT NULL,original jsonb NOT NULL,
 source_id uuid NOT NULL,source_version_id uuid NOT NULL,source_digest text NOT NULL,
 budget jsonb NOT NULL,rights_revision bigint NOT NULL,original_deadline timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'QUEUED',revision integer NOT NULL DEFAULT 0,generation integer NOT NULL DEFAULT 1,
 program jsonb,program_digest text,check_result jsonb,plan_revision_id uuid,job_id uuid,last_error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,principal_id,idempotency_key),UNIQUE(tenant_id,work_input_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id),
 FOREIGN KEY(source_id) REFERENCES finnor_os.evidence_sources(id),
 FOREIGN KEY(source_version_id) REFERENCES finnor_os.evidence_source_versions(id),
 CHECK(length(idempotency_key) BETWEEN 1 AND 160 AND request_digest ~ '^[a-f0-9]{64}$'
  AND original_digest ~ '^[a-f0-9]{64}$' AND source_digest ~ '^[a-f0-9]{64}$'
  AND octet_length(original::text)<=2097152 AND octet_length(budget::text)<=8388608
  AND octet_length(program::text)<=8388608 AND revision>=0 AND generation>=1),
 CHECK(status IN('QUEUED','CANDIDATE','AWAITING_ADOPTION','ADOPTED','TRIAL','ACTIVE','PARTIAL',
  'RETAINED','ROLLED_BACK','CANCELLED','INVALIDATED','UNKNOWN','FAILED'))
);
CREATE INDEX w5_original_work ON finnor_os.w5_requests(tenant_id,principal_id,work_id,created_at);
CREATE TABLE finnor_os.w5_revisions(
 tenant_id uuid NOT NULL,request_id uuid NOT NULL,principal_id uuid NOT NULL,revision integer NOT NULL,
 body jsonb NOT NULL,body_digest text NOT NULL,check_result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,request_id,revision),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.w5_requests(tenant_id,id),
 CHECK(body_digest ~ '^[a-f0-9]{64}$' AND octet_length(body::text)<=8388608)
);
CREATE TABLE finnor_os.w5_events(
 tenant_id uuid NOT NULL,request_id uuid NOT NULL,principal_id uuid NOT NULL,event_key text NOT NULL,
 kind text NOT NULL,body_digest text NOT NULL,body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,request_id,event_key),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.w5_requests(tenant_id,id),
 CHECK(length(event_key) BETWEEN 1 AND 240 AND octet_length(body::text)<=2097152)
);
CREATE TABLE finnor_os.w5_role_offers(
 tenant_id uuid NOT NULL,request_id uuid NOT NULL,principal_id uuid NOT NULL,participant_id uuid NOT NULL,
 role_id text NOT NULL,alternative_id text NOT NULL,terms_digest text NOT NULL,terms jsonb NOT NULL,
 disclosure jsonb NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,
 PRIMARY KEY(tenant_id,request_id,role_id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.w5_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,participant_id) REFERENCES finnor_os.users(tenant_id,id),
 CHECK(octet_length(disclosure::text)<=262144 AND terms_digest ~ '^[a-f0-9]{64}$')
);
CREATE TABLE finnor_os.w5_adoption_decisions(
 tenant_id uuid NOT NULL,id uuid NOT NULL,request_id uuid NOT NULL,principal_id uuid NOT NULL,
 participant_id uuid NOT NULL,role_id text NOT NULL,alternative_id text NOT NULL,terms_digest text NOT NULL,
 decision text NOT NULL CHECK(decision IN('ADOPT','DECLINE','REVOKE')),idempotency_key text NOT NULL,
 source_ref jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id,participant_id,idempotency_key),
 FOREIGN KEY(tenant_id,request_id,role_id) REFERENCES finnor_os.w5_role_offers(tenant_id,request_id,role_id),
 FOREIGN KEY(tenant_id,participant_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.w5_transition_links(
 tenant_id uuid NOT NULL,request_id uuid NOT NULL,principal_id uuid NOT NULL,transition_key text NOT NULL,
 direction text NOT NULL CHECK(direction IN('FORWARD','ROLLBACK')),population_digest text NOT NULL,
 bridge jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,request_id,transition_key),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.w5_requests(tenant_id,id),
 CHECK(octet_length(bridge::text)<=2097152)
);
CREATE TABLE finnor_os.w5_process_uses(
 tenant_id uuid NOT NULL,request_id uuid NOT NULL,principal_id uuid NOT NULL,participant_id uuid NOT NULL,
 use_key text NOT NULL,process_id text NOT NULL,role_id text NOT NULL,work_id uuid NOT NULL,
 input_digest text NOT NULL,source_ref jsonb NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,request_id,use_key),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.w5_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 CHECK(octet_length(result::text)<=262144)
);
CREATE TABLE finnor_os.w5_dependency_pins(
 tenant_id uuid NOT NULL,request_id uuid NOT NULL,principal_id uuid NOT NULL,kind text NOT NULL,
 source_id text NOT NULL,digest text NOT NULL,process_ids jsonb NOT NULL,
 PRIMARY KEY(tenant_id,request_id,kind,source_id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.w5_requests(tenant_id,id)
);
CREATE FUNCTION finnor_os.w5_immutable() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,finnor_os AS $$
BEGIN RAISE EXCEPTION 'W5 original evidence and transition history is append-only'; END $$;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['w5_revisions','w5_events','w5_adoption_decisions','w5_transition_links','w5_process_uses','w5_dependency_pins'] LOOP
  EXECUTE format('CREATE TRIGGER w5_append_only BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.w5_immutable()',tab);
 END LOOP;
END $$;
CREATE FUNCTION finnor_os.w5_original_fence() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'W5 original obligations cannot disappear'; END IF;
 IF (NEW.tenant_id,NEW.id,NEW.principal_id,NEW.company_id,NEW.work_id,NEW.work_input_id,
    NEW.idempotency_key,NEW.request_digest,NEW.original_digest,NEW.original_input_digest,NEW.original,NEW.budget,
    NEW.source_id,NEW.source_version_id,NEW.source_digest,NEW.original_deadline)
   IS DISTINCT FROM
   (OLD.tenant_id,OLD.id,OLD.principal_id,OLD.company_id,OLD.work_id,OLD.work_input_id,
    OLD.idempotency_key,OLD.request_digest,OLD.original_digest,OLD.original_input_digest,OLD.original,OLD.budget,
    OLD.source_id,OLD.source_version_id,OLD.source_digest,OLD.original_deadline)
   OR NEW.revision<OLD.revision OR NEW.generation<OLD.generation
   OR (NEW.program IS NOT NULL AND NEW.revision<>(NEW.program->>'revision')::integer)
 THEN RAISE EXCEPTION 'W5 original Work, terms, source, budget and deadline are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER w5_original_fence BEFORE UPDATE OR DELETE ON finnor_os.w5_requests
 FOR EACH ROW EXECUTE FUNCTION finnor_os.w5_original_fence();
DO $$ DECLARE tab text;role_name text; BEGIN
 FOREACH tab IN ARRAY ARRAY['w5_requests','w5_revisions','w5_events','w5_role_offers','w5_adoption_decisions',
   'w5_transition_links','w5_process_uses','w5_dependency_pins'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY w5_owner_read ON finnor_os.%I FOR SELECT USING(
   tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',tab);
  IF tab<>'w5_adoption_decisions' THEN
   EXECUTE format('CREATE POLICY w5_owner_insert ON finnor_os.%I FOR INSERT WITH CHECK(
    tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',tab);
  END IF;
  FOREACH role_name IN ARRAY ARRAY['finnor_app','finnor_worker'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
    EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO %I',tab,role_name);
   END IF;
  END LOOP;
 END LOOP;
END $$;
CREATE POLICY w5_owner_update ON finnor_os.w5_requests FOR UPDATE USING(
 tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY w5_offer_update ON finnor_os.w5_role_offers FOR UPDATE USING(
 tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY w5_self_offer ON finnor_os.w5_role_offers FOR SELECT USING(
 tenant_id=finnor_os.request_tenant_id() AND participant_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY w5_self_decision_read ON finnor_os.w5_adoption_decisions FOR SELECT USING(
 tenant_id=finnor_os.request_tenant_id() AND participant_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY w5_self_decision_insert ON finnor_os.w5_adoption_decisions FOR INSERT WITH CHECK(
 tenant_id=finnor_os.request_tenant_id() AND participant_id=nullif(current_setting('app.user_id',true),'')::uuid
 AND EXISTS(SELECT 1 FROM finnor_os.w5_role_offers o
  WHERE o.tenant_id=w5_adoption_decisions.tenant_id AND o.request_id=w5_adoption_decisions.request_id
   AND o.role_id=w5_adoption_decisions.role_id AND o.participant_id=w5_adoption_decisions.participant_id
   AND o.principal_id=w5_adoption_decisions.principal_id AND o.alternative_id=w5_adoption_decisions.alternative_id
   AND o.terms_digest=w5_adoption_decisions.terms_digest
   AND (w5_adoption_decisions.decision='REVOKE' OR (o.revoked_at IS NULL AND o.expires_at>clock_timestamp()))));
DO $$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['finnor_app','finnor_worker'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('GRANT UPDATE ON finnor_os.w5_requests,finnor_os.w5_role_offers TO %I',role_name);
  END IF;
 END LOOP;
END $$;
INSERT INTO finnor_os.compute_job_type_policies
 (job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES
 ('compile_organization_transformation_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
  'W5 bounded organization construction and independent invariant checking, original S5 reservation, no field/adoption/effect authority.'),
 ('advance_organization_transformation_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
  'W5 exact self-adoption and staged original-obligation bridge, canonical Work/S5/S6 and read-only ambiguous-effect recovery.');
