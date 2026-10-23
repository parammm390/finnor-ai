-- S3 artifacts and S4 projections only. No new evidence, allocation, effect,
-- mandate, signer or authority owner. Queue/native compute contracts are reused.
CREATE TABLE finnor_os.y2_episodes(
 tenant_id uuid NOT NULL,id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,
 deadline_at timestamptz NOT NULL,
 attempts_used integer NOT NULL DEFAULT 0 CHECK(attempts_used BETWEEN 0 AND 4),
 use_attempts_used integer NOT NULL DEFAULT 0 CHECK(use_attempts_used BETWEEN 0 AND 128),
 semantic_applications_used bigint NOT NULL DEFAULT 0 CHECK(semantic_applications_used BETWEEN 0 AND 264000000),
 retained_bytes bigint NOT NULL DEFAULT 0 CHECK(retained_bytes BETWEEN 0 AND 33554432),
 event_count integer NOT NULL DEFAULT 0 CHECK(event_count BETWEEN 0 AND 2048),
 uses_used integer NOT NULL DEFAULT 0 CHECK(uses_used BETWEEN 0 AND 32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,principal_id,work_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id)
);
CREATE TABLE finnor_os.y2_models(
 tenant_id uuid NOT NULL,id uuid NOT NULL,principal_id uuid NOT NULL,root jsonb NOT NULL,
 work_id uuid NOT NULL,work_input_id uuid NOT NULL,work_input_digest text NOT NULL,episode_id uuid NOT NULL,
 request jsonb NOT NULL CHECK(octet_length(request::text)<=2097152),request_digest text NOT NULL,
 runtime jsonb NOT NULL,rights_revision text NOT NULL,idempotency_key text NOT NULL,
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','FITTING','CHECKING','CHECKED','UNIDENTIFIED','NO_SUPPORTED_MODEL','UNKNOWN','INCOMPLETE','INVALIDATED','CANCELLED')),
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
 candidate jsonb,artifact jsonb CHECK(octet_length(artifact::text)<=4194304),admission jsonb,
 fallback_id uuid,cancelled boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id),
 FOREIGN KEY(tenant_id,episode_id) REFERENCES finnor_os.y2_episodes(tenant_id,id),
 FOREIGN KEY(tenant_id,fallback_id) REFERENCES finnor_os.y2_models(tenant_id,id)
);
CREATE TABLE finnor_os.y2_uses(
 tenant_id uuid NOT NULL,id uuid NOT NULL,model_id uuid NOT NULL,requested_model_id uuid NOT NULL,
 principal_id uuid NOT NULL,episode_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('PREDICT','DECISION')),
 request jsonb NOT NULL CHECK(octet_length(request::text)<=2097152),request_digest text NOT NULL,idempotency_key text NOT NULL,
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),model_generation integer NOT NULL CHECK(model_generation>0),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','EVALUATING','CHECKING','CHECKED','UNKNOWN','INCOMPLETE','INVALIDATED','CANCELLED')),
 candidate jsonb,check_result jsonb,artifact jsonb CHECK(octet_length(artifact::text)<=4194304),
 attempts_used integer NOT NULL DEFAULT 0 CHECK(attempts_used BETWEEN 0 AND 4),
 cancelled boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,model_id) REFERENCES finnor_os.y2_models(tenant_id,id),
 FOREIGN KEY(tenant_id,requested_model_id) REFERENCES finnor_os.y2_models(tenant_id,id),
 FOREIGN KEY(tenant_id,episode_id) REFERENCES finnor_os.y2_episodes(tenant_id,id)
);
CREATE TABLE finnor_os.y2_events(
 tenant_id uuid NOT NULL,id bigint GENERATED ALWAYS AS IDENTITY,model_id uuid NOT NULL,episode_id uuid NOT NULL,
 principal_id uuid NOT NULL,kind text NOT NULL,event_key text NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,model_id,event_key),
 FOREIGN KEY(tenant_id,model_id) REFERENCES finnor_os.y2_models(tenant_id,id),
 FOREIGN KEY(tenant_id,episode_id) REFERENCES finnor_os.y2_episodes(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.s8_strategic_response_admissions(
 tenant_id uuid NOT NULL,admission_id text NOT NULL,principal_id uuid NOT NULL,model_id uuid NOT NULL,
 body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,admission_id),UNIQUE(tenant_id,model_id),
 FOREIGN KEY(tenant_id,model_id) REFERENCES finnor_os.y2_models(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 CHECK(body->>'domain'='STRATEGIC_RESPONSE_MODEL_SET' AND body->>'protectionDomain'='DISPOSABLE_LOCAL_DEVELOPMENT'
  AND body->>'executionAuthorityGranted'='false' AND body->>'protectedAdmission'='false')
);
CREATE INDEX y2_model_work ON finnor_os.y2_models(tenant_id,principal_id,work_id,created_at DESC,id DESC);
CREATE INDEX y2_use_model ON finnor_os.y2_uses(tenant_id,model_id,created_at DESC,id DESC);
CREATE FUNCTION finnor_os.y2_original_episode() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Y2 original responsibility retained'; END IF;
 IF to_jsonb(NEW)-ARRAY['attempts_used','use_attempts_used','semantic_applications_used','retained_bytes','event_count','uses_used']
  IS DISTINCT FROM to_jsonb(OLD)-ARRAY['attempts_used','use_attempts_used','semantic_applications_used','retained_bytes','event_count','uses_used']
  OR NEW.attempts_used<OLD.attempts_used OR NEW.use_attempts_used<OLD.use_attempts_used
  OR NEW.semantic_applications_used<OLD.semantic_applications_used OR NEW.retained_bytes<OLD.retained_bytes
  OR NEW.event_count<OLD.event_count OR NEW.uses_used<OLD.uses_used
 THEN RAISE EXCEPTION 'Y2 original Work deadline and cumulative occupation cannot reset'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER y2_original_episode BEFORE UPDATE OR DELETE ON finnor_os.y2_episodes FOR EACH ROW EXECUTE FUNCTION finnor_os.y2_original_episode();
CREATE FUNCTION finnor_os.y2_progress() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Y2 immutable preimages retained'; END IF;
 IF to_jsonb(NEW)-ARRAY['status','generation','candidate','artifact','admission','check_result','attempts_used','cancelled']
  IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','generation','candidate','artifact','admission','check_result','attempts_used','cancelled']
  OR NEW.generation<OLD.generation OR OLD.cancelled AND NOT NEW.cancelled
  OR OLD.candidate IS NOT NULL AND NEW.candidate IS DISTINCT FROM OLD.candidate
  OR OLD.artifact IS NOT NULL AND NEW.artifact IS DISTINCT FROM OLD.artifact
  OR coalesce(to_jsonb(OLD)->'admission','null'::jsonb)<>'null'::jsonb AND to_jsonb(NEW)->'admission' IS DISTINCT FROM to_jsonb(OLD)->'admission'
 THEN RAISE EXCEPTION 'Y2 original inputs and published preimages cannot change'; END IF;
 IF (to_jsonb(NEW)->>'attempts_used')::integer<(to_jsonb(OLD)->>'attempts_used')::integer THEN RAISE EXCEPTION 'Y2 use attempts cannot reset'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER y2_model_progress BEFORE UPDATE OR DELETE ON finnor_os.y2_models FOR EACH ROW EXECUTE FUNCTION finnor_os.y2_progress();
CREATE TRIGGER y2_use_progress BEFORE UPDATE OR DELETE ON finnor_os.y2_uses FOR EACH ROW EXECUTE FUNCTION finnor_os.y2_progress();
CREATE FUNCTION finnor_os.y2_storage() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE delta bigint; episode uuid;
BEGIN
 IF TG_TABLE_NAME='s8_strategic_response_admissions' THEN
  SELECT episode_id INTO STRICT episode FROM finnor_os.y2_models WHERE tenant_id=NEW.tenant_id AND id=NEW.model_id;
 ELSE episode:=NEW.episode_id; END IF;
 delta:=octet_length(to_jsonb(NEW)::text)+512;
 IF TG_OP='UPDATE' THEN delta:=greatest(0,
  octet_length((to_jsonb(NEW)-ARRAY['status','generation','cancelled','attempts_used'])::text)
  -octet_length((to_jsonb(OLD)-ARRAY['status','generation','cancelled','attempts_used'])::text)); END IF;
 UPDATE finnor_os.y2_episodes SET retained_bytes=retained_bytes+delta,
  event_count=event_count+CASE WHEN TG_TABLE_NAME='y2_events' THEN 1 ELSE 0 END
 WHERE tenant_id=NEW.tenant_id AND id=episode;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['y2_episodes','y2_models','y2_uses','y2_events','s8_strategic_response_admissions'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY y2_scope ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  IF t IN('y2_episodes','y2_models','y2_uses') THEN EXECUTE format('GRANT UPDATE ON finnor_os.%I TO finnor_app',t);
  ELSE EXECUTE format('CREATE TRIGGER y2_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.s5_immutable_record()',t); END IF;
  IF t<>'y2_episodes' THEN
   EXECUTE format('CREATE TRIGGER y2_storage AFTER INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.y2_storage()',t);
  END IF;
 END LOOP;
END $$;
GRANT USAGE,SELECT ON SEQUENCE finnor_os.y2_events_id_seq TO finnor_app;
CREATE FUNCTION finnor_os.y2_input_changed() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_TABLE_NAME='work_inputs' THEN
  UPDATE finnor_os.y2_models SET status='INVALIDATED',generation=generation+1
   WHERE tenant_id=NEW.tenant_id AND work_id=NEW.work_id AND work_input_id<>NEW.id AND status<>'INVALIDATED' AND NOT cancelled;
 ELSIF TG_TABLE_NAME='evidence_source_versions' THEN
  UPDATE finnor_os.y2_models SET status='INVALIDATED',generation=generation+1
   WHERE tenant_id=NEW.tenant_id AND request->'evidence'->>'sourceId'=NEW.source_id::text
    AND request->'evidence'->>'versionId'<>NEW.id::text AND status<>'INVALIDATED' AND NOT cancelled;
 ELSE
  UPDATE finnor_os.y2_models SET status='INVALIDATED',generation=generation+1 WHERE tenant_id=NEW.tenant_id AND status<>'INVALIDATED' AND NOT cancelled;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER y2_work_changed AFTER INSERT ON finnor_os.work_inputs FOR EACH ROW EXECUTE FUNCTION finnor_os.y2_input_changed();
CREATE TRIGGER y2_source_changed AFTER INSERT ON finnor_os.evidence_source_versions FOR EACH ROW EXECUTE FUNCTION finnor_os.y2_input_changed();
CREATE TRIGGER y2_authority_changed AFTER UPDATE ON finnor_os.authority_states FOR EACH ROW EXECUTE FUNCTION finnor_os.y2_input_changed();
CREATE FUNCTION finnor_os.y2_descendant_invalidation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF NEW.status IN('INVALIDATED','CANCELLED') THEN
  UPDATE finnor_os.y2_uses SET status='INVALIDATED',generation=generation+1
   WHERE tenant_id=NEW.tenant_id AND model_id=NEW.id AND status NOT IN('INVALIDATED','CANCELLED') AND NOT cancelled;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER y2_descendant_invalidation AFTER UPDATE OF status ON finnor_os.y2_models FOR EACH ROW EXECUTE FUNCTION finnor_os.y2_descendant_invalidation();
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('learn_strategic_response_model_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'S3 finite actor-local learning and separate model-set checking under original Work; no effects or protected admission.'),
 ('evaluate_strategic_response_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'S3 joint prediction or actual S4 search with independent checking; original Work deadline and cumulative occupation, no effects.');
INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
 VALUES('native:y2-strategic-response',1,1,0,150,'One bounded actor-response learner, S4 evaluator and data-only checker stack');
