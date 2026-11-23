-- Proposed complete migration BODY, not applied. The coordinator assigns its
-- actual migration name and bundle entry against an exact current preimage.
-- No new tenant, user, grant of business authority, funding, signer or effect.
CREATE TABLE finnor_os.z5_component_profiles(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,profile_id text NOT NULL,work_id uuid NOT NULL,
 source_ref jsonb NOT NULL,digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=8388608),
 revoked_at timestamptz,revocation_reason text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,profile_id),UNIQUE(tenant_id,principal_id,profile_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 CHECK((body->>'schema'='finnor.s8.fixed-institution-components.v1'
  AND body->>'domain'='ORDINARY_DEVELOPMENT' AND body->>'protectedAdmission'='false'
  AND body->>'executionAuthorityGranted'='false') IS TRUE)
);
CREATE TABLE finnor_os.z5_link_episodes(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,
 deadline_at timestamptz NOT NULL,parent_reservation jsonb NOT NULL,responsibility_identity text NOT NULL,
 requests integer NOT NULL DEFAULT 0 CHECK(requests BETWEEN 0 AND 4),
 deliveries integer NOT NULL DEFAULT 0 CHECK(deliveries BETWEEN 0 AND 4),
 retained_bytes bigint NOT NULL DEFAULT 0 CHECK(retained_bytes BETWEEN 0 AND 67108864),
 event_count integer NOT NULL DEFAULT 0 CHECK(event_count BETWEEN 0 AND 512),
 uses integer NOT NULL DEFAULT 0 CHECK(uses BETWEEN 0 AND 32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,work_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id)
);
CREATE TABLE finnor_os.z5_link_requests(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,id uuid NOT NULL,work_id uuid NOT NULL,root jsonb NOT NULL,
 request jsonb NOT NULL CHECK(octet_length(request::text)<=65536),request_digest text NOT NULL,idempotency_key text NOT NULL,
 input jsonb NOT NULL CHECK(octet_length(input::text)<=8388608),cut jsonb NOT NULL CHECK(octet_length(cut::text)<=1048576),
 profile_ref jsonb NOT NULL,work_input_id uuid NOT NULL,work_input_digest text NOT NULL,rights_revision text NOT NULL,
 source_digest text NOT NULL,generation integer NOT NULL DEFAULT 1 CHECK(generation BETWEEN 1 AND 64),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','RUNNING','CHECKED_CANDIDATE','CHECKED_INFEASIBLE',
  'UNSUPPORTED','INCOMPLETE','UNKNOWN','USED','STALE','REVOKED','CANCELLED')),
 deadline_at timestamptz NOT NULL,deliveries integer NOT NULL DEFAULT 0 CHECK(deliveries BETWEEN 0 AND 4),
 cancel_requested boolean NOT NULL DEFAULT false,claim_token uuid,claim_fence bigint,artifact_digest text,admission jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,principal_id,id),UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id,work_id) REFERENCES finnor_os.z5_link_episodes(tenant_id,principal_id,work_id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id)
);
CREATE INDEX z5_requests_work ON finnor_os.z5_link_requests(tenant_id,principal_id,work_id,created_at DESC,id DESC);
CREATE TABLE finnor_os.z5_link_events(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,request_id uuid NOT NULL,
 sequence bigint GENERATED ALWAYS AS IDENTITY,event_id text NOT NULL,kind text NOT NULL,event_key text NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=8388608),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,sequence),UNIQUE(tenant_id,request_id,event_key),
 FOREIGN KEY(tenant_id,principal_id,request_id) REFERENCES finnor_os.z5_link_requests(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.z5_link_artifacts(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,request_id uuid NOT NULL,digest text NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=33554432),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,request_id,digest),UNIQUE(tenant_id,principal_id,request_id,digest),
 FOREIGN KEY(tenant_id,principal_id,request_id) REFERENCES finnor_os.z5_link_requests(tenant_id,principal_id,id),
 CHECK((body->>'schema'='finnor.z5.native-artifact.v1' AND body->'envelope'->>'phase'='Z5'
  AND body->'envelope'->>'principalOutputType'='InstitutionCompositionCertificate'
  AND body->'certificate'->>'protectedAdmission'='false'
  AND body->'certificate'->>'executionAuthorityGranted'='false') IS TRUE)
);
ALTER TABLE finnor_os.z5_link_requests ADD CONSTRAINT z5_immutable_artifact_head
 FOREIGN KEY(tenant_id,principal_id,id,artifact_digest)
 REFERENCES finnor_os.z5_link_artifacts(tenant_id,principal_id,request_id,digest);
CREATE TABLE finnor_os.z5_link_attempts(
 id uuid NOT NULL,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,request_id uuid NOT NULL,
 delivery_id uuid NOT NULL,claim_fence bigint NOT NULL,charge_ref jsonb,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,delivery_id),
 FOREIGN KEY(tenant_id,principal_id,request_id) REFERENCES finnor_os.z5_link_requests(tenant_id,principal_id,id),
 FOREIGN KEY(delivery_id) REFERENCES finnor_os.job_delivery_attempts(id)
);
CREATE TABLE finnor_os.z5_s8_admissions(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,request_id uuid NOT NULL,admission_id text NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,admission_id),UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,principal_id,request_id) REFERENCES finnor_os.z5_link_requests(tenant_id,principal_id,id),
 CHECK((body->>'schema'='finnor.s8.institution-composition-admission.v1'
  AND body->>'domain'='ORDINARY_DEVELOPMENT' AND body->>'protectedAdmission'='false'
  AND body->>'productionActivated'='false' AND body->>'executionAuthorityGranted'='false') IS TRUE)
);
CREATE TABLE finnor_os.z5_s4_uses(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,request_id uuid NOT NULL,use_id text NOT NULL,
 idempotency_key text NOT NULL,request_digest text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=8388608),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,use_id),
 UNIQUE(tenant_id,principal_id,use_id),UNIQUE(tenant_id,principal_id,request_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id,request_id) REFERENCES finnor_os.z5_link_requests(tenant_id,principal_id,id),
 CHECK((body->>'schema'='finnor.s4.institution-composition-use.v1'
  AND body->>'effectAuthorityGranted'='false' AND body->>'newAllowance'='false') IS TRUE)
);
CREATE TABLE finnor_os.z5_s4_heads(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,policy_id text NOT NULL,allocation_id text NOT NULL,
 request_id uuid NOT NULL,use_id text NOT NULL,
 PRIMARY KEY(tenant_id,principal_id,work_id,policy_id,allocation_id),
 FOREIGN KEY(tenant_id,principal_id,request_id) REFERENCES finnor_os.z5_link_requests(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,use_id) REFERENCES finnor_os.z5_s4_uses(tenant_id,principal_id,use_id)
);
CREATE FUNCTION finnor_os.z5_request_progress() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Z5 original responsibility and old liabilities cannot disappear'; END IF;
 IF to_jsonb(NEW)-ARRAY['status','generation','deliveries','cancel_requested','claim_token','claim_fence','artifact_digest','admission']
 IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','generation','deliveries','cancel_requested','claim_token','claim_fence','artifact_digest','admission']
 OR NEW.generation<OLD.generation OR NEW.deliveries<OLD.deliveries
 OR OLD.cancel_requested AND NOT NEW.cancel_requested
 OR OLD.artifact_digest IS NOT NULL AND NEW.artifact_digest IS DISTINCT FROM OLD.artifact_digest
 OR OLD.admission IS NOT NULL AND NEW.admission IS DISTINCT FROM OLD.admission
 OR OLD.claim_fence IS NOT NULL AND (NEW.claim_fence IS NULL OR NEW.claim_fence<OLD.claim_fence)
 THEN RAISE EXCEPTION 'Z5 original inputs, publication preimages, deadlines and cumulative debits are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER z5_request_progress BEFORE UPDATE OR DELETE ON finnor_os.z5_link_requests
 FOR EACH ROW EXECUTE FUNCTION finnor_os.z5_request_progress();
CREATE FUNCTION finnor_os.z5_episode_progress() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Z5 original episode cannot disappear'; END IF;
 IF to_jsonb(NEW)-ARRAY['requests','deliveries','retained_bytes','event_count','uses']
 IS DISTINCT FROM to_jsonb(OLD)-ARRAY['requests','deliveries','retained_bytes','event_count','uses']
 OR NEW.requests<OLD.requests OR NEW.deliveries<OLD.deliveries OR NEW.retained_bytes<OLD.retained_bytes
 OR NEW.event_count<OLD.event_count OR NEW.uses<OLD.uses
 THEN RAISE EXCEPTION 'Z5 original allowance and occupation cannot reset'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER z5_episode_progress BEFORE UPDATE OR DELETE ON finnor_os.z5_link_episodes
 FOR EACH ROW EXECUTE FUNCTION finnor_os.z5_episode_progress();
CREATE FUNCTION finnor_os.z5_profile_progress() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE n integer; bytes bigint;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Z5 original fixed profile cannot disappear'; END IF;
 IF TG_OP='UPDATE' THEN
  IF to_jsonb(NEW)-ARRAY['revoked_at','revocation_reason'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['revoked_at','revocation_reason']
   OR OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
  THEN RAISE EXCEPTION 'Z5 original admitted fixed revisions cannot be edited or unrevoked'; END IF;
 ELSE
  PERFORM 1 FROM finnor_os.works WHERE tenant_id=NEW.tenant_id AND id=NEW.work_id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM finnor_os.z5_component_profiles WHERE tenant_id=NEW.tenant_id AND profile_id=NEW.profile_id) THEN
   SELECT count(*),coalesce(sum(octet_length(body::text)),0) INTO n,bytes FROM finnor_os.z5_component_profiles
    WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id AND work_id=NEW.work_id;
   IF n>=4 OR bytes+octet_length(NEW.body::text)>33554432 THEN RAISE EXCEPTION 'Z5 fixed-profile byte/count bound'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER z5_profile_progress BEFORE INSERT OR UPDATE OR DELETE ON finnor_os.z5_component_profiles
 FOR EACH ROW EXECUTE FUNCTION finnor_os.z5_profile_progress();
CREATE FUNCTION finnor_os.z5_attempt_progress() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM finnor_os.job_delivery_attempts d JOIN finnor_os.jobs j ON j.id=d.job_id
   WHERE d.id=NEW.delivery_id AND d.tenant_id=NEW.tenant_id AND j.tenant_id=NEW.tenant_id
    AND d.claim_fence=NEW.claim_fence AND j.payload->>'requestId'=NEW.request_id::text
    AND j.payload->>'principalId'=NEW.principal_id::text AND j.type='link_institution_components_v1')
  THEN RAISE EXCEPTION 'Z5 physical delivery must belong to the exact tenant principal and request'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' OR to_jsonb(NEW)-ARRAY['charge_ref','body','finished_at']
  IS DISTINCT FROM to_jsonb(OLD)-ARRAY['charge_ref','body','finished_at']
  OR OLD.charge_ref IS NOT NULL AND NEW.charge_ref IS DISTINCT FROM OLD.charge_ref
  OR OLD.finished_at IS NOT NULL AND NEW.finished_at IS DISTINCT FROM OLD.finished_at
  OR OLD.body-(ARRAY['disposition','costRef','hardKillTail']) IS DISTINCT FROM NEW.body-(ARRAY['disposition','costRef','hardKillTail'])
 THEN RAISE EXCEPTION 'Z5 physical attempts and already committed costs cannot be replaced'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER z5_attempt_progress BEFORE INSERT OR UPDATE OR DELETE ON finnor_os.z5_link_attempts
 FOR EACH ROW EXECUTE FUNCTION finnor_os.z5_attempt_progress();
CREATE FUNCTION finnor_os.z5_storage() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE work uuid; amount bigint;
BEGIN
 -- Original INSERT reserves 512 bytes for bounded terminal control metadata.
 -- Exhaustion must not make cancellation, revocation or a refusal impossible.
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='z5_link_requests' THEN
  IF NEW.status IN('INCOMPLETE','UNKNOWN','STALE','REVOKED','CANCELLED')
   AND to_jsonb(NEW)-ARRAY['status','generation','cancel_requested']
    IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY['status','generation','cancel_requested'] THEN
   IF octet_length(to_jsonb(NEW)::text)-octet_length(to_jsonb(OLD)::text)>512
    THEN RAISE EXCEPTION 'Z5_TERMINAL_FENCE_METADATA_BOUND'; END IF;
   RETURN NEW;
  END IF;
 END IF;
 IF TG_TABLE_NAME IN('z5_link_requests','z5_s4_heads') THEN work:=NEW.work_id;
 ELSE SELECT work_id INTO work FROM finnor_os.z5_link_requests WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id; END IF;
 IF TG_OP='INSERT' THEN amount:=octet_length(to_jsonb(NEW)::text)+512;
 ELSE amount:=greatest(0,octet_length(to_jsonb(NEW)::text)-octet_length(to_jsonb(OLD)::text)); END IF;
 UPDATE finnor_os.z5_link_episodes SET retained_bytes=retained_bytes+amount,
  event_count=event_count+CASE WHEN TG_OP='INSERT' AND TG_TABLE_NAME='z5_link_events' THEN 1 ELSE 0 END,
  uses=uses+CASE WHEN TG_OP='INSERT' AND TG_TABLE_NAME='z5_s4_uses' THEN 1 ELSE 0 END
 WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id AND work_id=work;
 IF NOT FOUND THEN RAISE EXCEPTION 'Z5 original budget episode missing'; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['z5_component_profiles','z5_link_episodes','z5_link_requests','z5_link_events',
  'z5_link_artifacts','z5_link_attempts','z5_s8_admissions','z5_s4_uses','z5_s4_heads'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY z5_tenant_principal ON finnor_os.%I
   USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)
   WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  IF t IN('z5_component_profiles','z5_link_episodes','z5_link_requests','z5_link_attempts','z5_s4_heads') THEN
   EXECUTE format('GRANT UPDATE ON finnor_os.%I TO finnor_app',t);
  ELSE
   EXECUTE format('CREATE TRIGGER z5_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I
    FOR EACH ROW EXECUTE FUNCTION finnor_os.s5_immutable_record()',t);
  END IF;
  IF t IN('z5_link_requests','z5_link_events','z5_link_artifacts','z5_link_attempts','z5_s8_admissions','z5_s4_uses','z5_s4_heads') THEN
   EXECUTE format('CREATE TRIGGER z5_storage AFTER INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.z5_storage()',t);
  END IF;
 END LOOP;
END $$;
GRANT USAGE,SELECT ON SEQUENCE finnor_os.z5_link_events_sequence_seq TO finnor_app;
CREATE FUNCTION finnor_os.z5_native_changed() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_TABLE_NAME='work_inputs' THEN
  UPDATE finnor_os.z5_link_requests SET status='STALE',generation=generation+1
   WHERE tenant_id=NEW.tenant_id AND work_id=NEW.work_id AND work_input_id<>NEW.id
    AND status NOT IN('STALE','REVOKED','CANCELLED');
 ELSE
  UPDATE finnor_os.z5_link_requests SET status='STALE',generation=generation+1
   WHERE tenant_id=NEW.tenant_id AND status NOT IN('STALE','REVOKED','CANCELLED');
 END IF;
 -- Principal RLS intentionally does not disclose or mutate another employee's
 -- private row. Their next claim/read/use independently detects the new cut.
 RETURN NEW;
END $$;
CREATE TRIGGER z5_work_changed AFTER INSERT ON finnor_os.work_inputs FOR EACH ROW EXECUTE FUNCTION finnor_os.z5_native_changed();
CREATE TRIGGER z5_rights_changed AFTER UPDATE ON finnor_os.authority_states FOR EACH ROW EXECUTE FUNCTION finnor_os.z5_native_changed();
-- Read fences also check all native S4/S5/S6 current bytes and source dependencies.
INSERT INTO finnor_os.compute_job_type_policies
 (job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('link_institution_components_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'Z5 original fixed coupled contract/checker/planning only; original S5 allowance, carried S6 obligations, no effect or protected admission.');
INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
 VALUES('native:z5-institution-linker',1,1,0,150,'One bounded Z5 original-product producer or independent checker stack; original workload allowance');
REVOKE ALL ON FUNCTION finnor_os.z5_request_progress(),finnor_os.z5_episode_progress(),
 finnor_os.z5_profile_progress(),finnor_os.z5_attempt_progress(),finnor_os.z5_storage(),finnor_os.z5_native_changed() FROM PUBLIC;
