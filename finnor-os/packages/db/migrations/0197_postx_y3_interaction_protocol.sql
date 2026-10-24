-- Y3 owns protocol artifacts and S4 interaction bindings. S5 resources, Y1
-- operator meanings and S6/S7 effects remain in their existing owners.
-- 0195 is pinned Y1; 0196 is reserved by the inspected Y2 peer, not adopted here.
CREATE TABLE finnor_os.y3_episodes(
 tenant_id uuid NOT NULL,id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,
 deadline_at timestamptz NOT NULL,attempts_used integer NOT NULL DEFAULT 0 CHECK(attempts_used BETWEEN 0 AND 4),
 search_steps_used integer NOT NULL DEFAULT 0 CHECK(search_steps_used BETWEEN 0 AND 400000),
 retained_bytes bigint NOT NULL DEFAULT 0 CHECK(retained_bytes BETWEEN 0 AND 33554432),
 event_count integer NOT NULL DEFAULT 0 CHECK(event_count BETWEEN 0 AND 2048),
 uses_used integer NOT NULL DEFAULT 0 CHECK(uses_used BETWEEN 0 AND 32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,principal_id,work_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id)
);
CREATE TABLE finnor_os.y3_requests(
 tenant_id uuid NOT NULL,id uuid NOT NULL,principal_id uuid NOT NULL,root jsonb NOT NULL,work_id uuid NOT NULL,
 work_input_id uuid NOT NULL,work_input_digest text NOT NULL,episode_id uuid NOT NULL,theory_id uuid NOT NULL,
 request jsonb NOT NULL CHECK(octet_length(request::text)<=2097152),request_digest text NOT NULL,
 runtime jsonb NOT NULL,rights_revision text NOT NULL,idempotency_key text NOT NULL,
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','CONSTRUCTING','CHECKING','CANDIDATE','CHECKED','INCOMPLETE','INFEASIBLE','UNSUPPORTED','UNKNOWN','INVALIDATED','CANCELLED')),
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),candidate jsonb,construction jsonb,
 artifact jsonb CHECK(octet_length(artifact::text)<=8388608),admission jsonb,fallback_id uuid,
 current_terms_id uuid,cancelled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id),
 FOREIGN KEY(tenant_id,episode_id) REFERENCES finnor_os.y3_episodes(tenant_id,id),
 FOREIGN KEY(tenant_id,theory_id) REFERENCES finnor_os.y1_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,fallback_id) REFERENCES finnor_os.y3_requests(tenant_id,id)
);
CREATE INDEX y3_work ON finnor_os.y3_requests(tenant_id,principal_id,work_id,created_at DESC,id DESC);
CREATE TABLE finnor_os.y3_events(
 tenant_id uuid NOT NULL,id bigint GENERATED ALWAYS AS IDENTITY,protocol_id uuid NOT NULL,episode_id uuid NOT NULL,
 principal_id uuid NOT NULL,kind text NOT NULL,event_key text NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,protocol_id,event_key),
 FOREIGN KEY(tenant_id,protocol_id) REFERENCES finnor_os.y3_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,episode_id) REFERENCES finnor_os.y3_episodes(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.s8_interaction_admissions(
 tenant_id uuid NOT NULL,admission_id text NOT NULL,principal_id uuid NOT NULL,protocol_id uuid NOT NULL,episode_id uuid NOT NULL,
 body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,admission_id),
 UNIQUE(tenant_id,protocol_id),
 FOREIGN KEY(tenant_id,protocol_id) REFERENCES finnor_os.y3_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,episode_id) REFERENCES finnor_os.y3_episodes(tenant_id,id),
 CHECK(body->>'domain'='INTERACTION_PROTOCOL' AND body->>'protectionDomain'='DISPOSABLE_LOCAL_DEVELOPMENT'
  AND body->>'executionAuthorityGranted'='false' AND body->>'protectedAdmission'='false' AND body->>'productionActivated'='false')
);
CREATE TABLE finnor_os.s4_interaction_terms(
 tenant_id uuid NOT NULL,id uuid NOT NULL,principal_id uuid NOT NULL,protocol_id uuid NOT NULL,episode_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),
 request_digest text NOT NULL,idempotency_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,protocol_id,revision),UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,protocol_id) REFERENCES finnor_os.y3_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,episode_id) REFERENCES finnor_os.y3_episodes(tenant_id,id)
);
ALTER TABLE finnor_os.y3_requests ADD CONSTRAINT y3_terms_head
 FOREIGN KEY(tenant_id,current_terms_id) REFERENCES finnor_os.s4_interaction_terms(tenant_id,id);
CREATE TABLE finnor_os.s4_interaction_consents(
 tenant_id uuid NOT NULL,id bigint GENERATED ALWAYS AS IDENTITY,consent_id uuid NOT NULL,principal_id uuid NOT NULL,
 protocol_id uuid NOT NULL,terms_id uuid NOT NULL,episode_id uuid NOT NULL,
 scope text NOT NULL CHECK(scope IN('TERMS','EFFECT')),subject_digest text NOT NULL,
 decision text NOT NULL CHECK(decision IN('ACCEPT','WITHDRAW')),body jsonb NOT NULL,
 request_digest text NOT NULL,idempotency_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,consent_id),UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,protocol_id) REFERENCES finnor_os.y3_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,terms_id) REFERENCES finnor_os.s4_interaction_terms(tenant_id,id),
 FOREIGN KEY(tenant_id,episode_id) REFERENCES finnor_os.y3_episodes(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE INDEX y3_exact_consent ON finnor_os.s4_interaction_consents(tenant_id,terms_id,scope,subject_digest,principal_id,id DESC);
CREATE TABLE finnor_os.s4_interaction_runs(
 tenant_id uuid NOT NULL,id uuid NOT NULL,principal_id uuid NOT NULL,protocol_id uuid NOT NULL,
 terms_id uuid NOT NULL,episode_id uuid NOT NULL,body jsonb NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 257),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN('ACTIVE','READY','MATERIALIZED','UNKNOWN')),
 intent jsonb,programme_id uuid,request_digest text NOT NULL,idempotency_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,protocol_id) REFERENCES finnor_os.y3_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,terms_id) REFERENCES finnor_os.s4_interaction_terms(tenant_id,id),
 FOREIGN KEY(tenant_id,episode_id) REFERENCES finnor_os.y3_episodes(tenant_id,id),
 FOREIGN KEY(tenant_id,programme_id) REFERENCES finnor_os.s4_economic_programmes(tenant_id,id)
);
CREATE TABLE finnor_os.s4_interaction_history(
 tenant_id uuid NOT NULL,id bigint GENERATED ALWAYS AS IDENTITY,event_id uuid NOT NULL,principal_id uuid NOT NULL,
 run_id uuid NOT NULL,protocol_id uuid NOT NULL,episode_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('OBSERVATION','ACTION')),body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),
 request_digest text NOT NULL,idempotency_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,event_id),UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,run_id) REFERENCES finnor_os.s4_interaction_runs(tenant_id,id),
 FOREIGN KEY(tenant_id,protocol_id) REFERENCES finnor_os.y3_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,episode_id) REFERENCES finnor_os.y3_episodes(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.s4_interaction_programme_bindings(
 tenant_id uuid NOT NULL,programme_id uuid NOT NULL,principal_id uuid NOT NULL,protocol_id uuid NOT NULL,
 terms_id uuid NOT NULL,run_id uuid NOT NULL,episode_id uuid NOT NULL,body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,programme_id),
 UNIQUE(tenant_id,run_id),
 FOREIGN KEY(tenant_id,programme_id) REFERENCES finnor_os.s4_economic_programmes(tenant_id,id),
 FOREIGN KEY(tenant_id,protocol_id) REFERENCES finnor_os.y3_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,terms_id) REFERENCES finnor_os.s4_interaction_terms(tenant_id,id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES finnor_os.s4_interaction_runs(tenant_id,id),
 FOREIGN KEY(tenant_id,episode_id) REFERENCES finnor_os.y3_episodes(tenant_id,id)
);
CREATE FUNCTION finnor_os.y3_original_episode() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF to_jsonb(NEW)-ARRAY['attempts_used','search_steps_used','retained_bytes','event_count','uses_used']
 IS DISTINCT FROM to_jsonb(OLD)-ARRAY['attempts_used','search_steps_used','retained_bytes','event_count','uses_used']
 OR NEW.attempts_used<OLD.attempts_used OR NEW.search_steps_used<OLD.search_steps_used
 OR NEW.retained_bytes<OLD.retained_bytes OR NEW.event_count<OLD.event_count OR NEW.uses_used<OLD.uses_used
 THEN RAISE EXCEPTION 'Y3 original episode, deadline and occupied resources cannot reset'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER y3_original_episode BEFORE UPDATE ON finnor_os.y3_episodes FOR EACH ROW EXECUTE FUNCTION finnor_os.y3_original_episode();
CREATE FUNCTION finnor_os.y3_request_progress() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Y3 original responsibility cannot disappear'; END IF;
 IF to_jsonb(NEW)-ARRAY['status','generation','candidate','construction','artifact','admission','cancelled','current_terms_id']
 IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','generation','candidate','construction','artifact','admission','cancelled','current_terms_id']
 OR NEW.generation<OLD.generation OR OLD.cancelled AND NOT NEW.cancelled
 OR OLD.candidate IS NOT NULL AND NEW.candidate IS DISTINCT FROM OLD.candidate
 OR OLD.artifact IS NOT NULL AND NEW.artifact IS DISTINCT FROM OLD.artifact
 OR OLD.admission IS NOT NULL AND NEW.admission IS DISTINCT FROM OLD.admission
 THEN RAISE EXCEPTION 'Y3 original inputs, candidates and publication preimages are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER y3_request_progress BEFORE UPDATE OR DELETE ON finnor_os.y3_requests FOR EACH ROW EXECUTE FUNCTION finnor_os.y3_request_progress();
CREATE FUNCTION finnor_os.y3_run_progress() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_OP='DELETE' OR to_jsonb(NEW)-ARRAY['revision','status','intent','programme_id']
 IS DISTINCT FROM to_jsonb(OLD)-ARRAY['revision','status','intent','programme_id']
 OR NEW.revision<OLD.revision OR OLD.intent IS NOT NULL AND NEW.intent IS DISTINCT FROM OLD.intent
 OR OLD.programme_id IS NOT NULL AND NEW.programme_id IS DISTINCT FROM OLD.programme_id
 OR OLD.status='MATERIALIZED' AND NEW.status<>'MATERIALIZED'
 THEN RAISE EXCEPTION 'S4 original interaction history and intent cannot be replaced'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER y3_run_progress BEFORE UPDATE OR DELETE ON finnor_os.s4_interaction_runs FOR EACH ROW EXECUTE FUNCTION finnor_os.y3_run_progress();
CREATE FUNCTION finnor_os.y3_storage() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE delta bigint;
BEGIN
 delta:=octet_length(to_jsonb(NEW)::text)+512;
 IF TG_OP='UPDATE' THEN
  delta:=greatest(0,octet_length((to_jsonb(NEW)-ARRAY['status','generation','cancelled','revision','current_terms_id'])::text)
   -octet_length((to_jsonb(OLD)-ARRAY['status','generation','cancelled','revision','current_terms_id'])::text));
 END IF;
 UPDATE finnor_os.y3_episodes SET retained_bytes=retained_bytes+delta,
  event_count=event_count+CASE WHEN TG_TABLE_NAME='y3_events' THEN 1 ELSE 0 END
 WHERE tenant_id=NEW.tenant_id AND id=NEW.episode_id;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['y3_episodes','y3_requests','y3_events','s8_interaction_admissions','s4_interaction_terms',
  's4_interaction_consents','s4_interaction_runs','s4_interaction_history','s4_interaction_programme_bindings'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY y3_tenant ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id()) WITH CHECK(tenant_id=finnor_os.request_tenant_id())',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  IF t IN('y3_episodes','y3_requests','s4_interaction_runs') THEN
   EXECUTE format('GRANT UPDATE ON finnor_os.%I TO finnor_app',t);
  ELSE
   EXECUTE format('CREATE TRIGGER y3_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.s5_immutable_record()',t);
  END IF;
  IF t<>'y3_episodes' THEN
   EXECUTE format('CREATE TRIGGER y3_storage AFTER INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.y3_storage()',t);
  END IF;
 END LOOP;
END $$;
GRANT USAGE,SELECT ON SEQUENCE finnor_os.y3_events_id_seq,finnor_os.s4_interaction_consents_id_seq,finnor_os.s4_interaction_history_id_seq TO finnor_app;
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('construct_interaction_protocol_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'Y3 bounded dynamic protocol construction and independent exact original-tree checking; original episode, no effect or protected authority.');
INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
 VALUES('native:y3-construction',1,1,0,150,'One Y3 producer/checker stack with bounded exact arithmetic and original resource accounting');
CREATE FUNCTION finnor_os.y3_input_changed() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_TABLE_NAME='work_inputs' THEN
  UPDATE finnor_os.y3_requests SET status='INVALIDATED',generation=generation+1
   WHERE tenant_id=NEW.tenant_id AND work_id=NEW.work_id AND work_input_id<>NEW.id AND status<>'INVALIDATED' AND NOT cancelled;
 ELSIF TG_TABLE_NAME='evidence_source_versions' THEN
  UPDATE finnor_os.y3_requests r SET status='INVALIDATED',generation=generation+1
   WHERE r.tenant_id=NEW.tenant_id AND r.status<>'INVALIDATED' AND NOT r.cancelled
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.request->'sources') s WHERE s->>'sourceId'=NEW.source_id::text AND s->>'versionId'<>NEW.id::text);
 ELSIF TG_TABLE_NAME='y1_requests' THEN
  IF NEW.status IN('INVALIDATED','CANCELLED') OR NEW.cancelled THEN
   UPDATE finnor_os.y3_requests SET status='INVALIDATED',generation=generation+1
    WHERE tenant_id=NEW.tenant_id AND theory_id=NEW.id AND status<>'INVALIDATED' AND NOT cancelled;
  END IF;
 ELSE
  UPDATE finnor_os.y3_requests SET status='INVALIDATED',generation=generation+1
   WHERE tenant_id=NEW.tenant_id AND status<>'INVALIDATED' AND NOT cancelled;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER y3_work_changed AFTER INSERT ON finnor_os.work_inputs FOR EACH ROW EXECUTE FUNCTION finnor_os.y3_input_changed();
CREATE TRIGGER y3_source_changed AFTER INSERT ON finnor_os.evidence_source_versions FOR EACH ROW EXECUTE FUNCTION finnor_os.y3_input_changed();
CREATE TRIGGER y3_authority_changed AFTER UPDATE ON finnor_os.authority_states FOR EACH ROW EXECUTE FUNCTION finnor_os.y3_input_changed();
CREATE TRIGGER y3_meaning_changed AFTER UPDATE ON finnor_os.y1_requests FOR EACH ROW EXECUTE FUNCTION finnor_os.y3_input_changed();
