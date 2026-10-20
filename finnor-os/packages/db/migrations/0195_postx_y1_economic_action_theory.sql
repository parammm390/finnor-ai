-- Additive Y1 construction artifacts and typed S4/S8/S6 origins. Resource and
-- effect lifecycles stay in the canonical S5 and business-effect owners.
CREATE TABLE finnor_os.y1_episodes(
 tenant_id uuid NOT NULL,id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,
 deadline_at timestamptz NOT NULL,attempts_used integer NOT NULL DEFAULT 0 CHECK(attempts_used BETWEEN 0 AND 4),
 search_steps_used integer NOT NULL DEFAULT 0 CHECK(search_steps_used BETWEEN 0 AND 262144),
 semantic_applications_used bigint NOT NULL DEFAULT 0 CHECK(semantic_applications_used BETWEEN 0 AND 32000000),
 retained_bytes bigint NOT NULL DEFAULT 0 CHECK(retained_bytes BETWEEN 0 AND 16777216),
 event_count integer NOT NULL DEFAULT 0 CHECK(event_count BETWEEN 0 AND 2048),
 uses_used integer NOT NULL DEFAULT 0 CHECK(uses_used BETWEEN 0 AND 32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,principal_id,work_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id)
);
CREATE TABLE finnor_os.y1_requests(
 tenant_id uuid NOT NULL,id uuid NOT NULL,principal_id uuid NOT NULL,root jsonb NOT NULL,work_id uuid NOT NULL,
 work_input_id uuid NOT NULL,work_input_digest text NOT NULL,episode_id uuid NOT NULL,
 request jsonb NOT NULL CHECK(octet_length(request::text)<=2097152),request_digest text NOT NULL,
 runtime jsonb NOT NULL,rights_revision text NOT NULL,idempotency_key text NOT NULL,
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','CONSTRUCTING','CHECKING','CANDIDATE','CHECKED','INCOMPLETE','INFEASIBLE','UNIDENTIFIED','UNSUPPORTED','UNKNOWN','INVALIDATED','CANCELLED')),
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),candidate jsonb,construction jsonb,
 artifact jsonb CHECK(octet_length(artifact::text)<=4194304),admission jsonb,fallback_id uuid,cancelled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id),
 FOREIGN KEY(tenant_id,episode_id) REFERENCES finnor_os.y1_episodes(tenant_id,id),
 FOREIGN KEY(tenant_id,fallback_id) REFERENCES finnor_os.y1_requests(tenant_id,id)
);
CREATE TABLE finnor_os.y1_events(
 tenant_id uuid NOT NULL,id bigint GENERATED ALWAYS AS IDENTITY,theory_id uuid NOT NULL,episode_id uuid NOT NULL,
 principal_id uuid NOT NULL,kind text NOT NULL,event_key text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,theory_id,event_key),
 FOREIGN KEY(tenant_id,theory_id) REFERENCES finnor_os.y1_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,episode_id) REFERENCES finnor_os.y1_episodes(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.s8_economic_theory_admissions(
 tenant_id uuid NOT NULL,admission_id text NOT NULL,principal_id uuid NOT NULL,theory_id uuid NOT NULL,
 body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,admission_id),
 UNIQUE(tenant_id,theory_id),
 FOREIGN KEY(tenant_id,theory_id) REFERENCES finnor_os.y1_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 CHECK(body->>'domain'='ECONOMIC_ACTION_THEORY' AND body->>'protectionDomain'='DISPOSABLE_LOCAL_DEVELOPMENT'
  AND body->>'executionAuthorityGranted'='false' AND body->>'protectedAdmission'='false')
);
CREATE TABLE finnor_os.s4_economic_programmes(
 tenant_id uuid NOT NULL,id uuid NOT NULL,principal_id uuid NOT NULL,theory_id uuid NOT NULL,work_id uuid NOT NULL,
 episode_id uuid NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=262144),request_digest text NOT NULL,idempotency_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,theory_id) REFERENCES finnor_os.y1_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,episode_id) REFERENCES finnor_os.y1_episodes(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.s6_economic_obligation_origins(
 tenant_id uuid NOT NULL,obligation_id text NOT NULL,principal_id uuid NOT NULL,programme_id uuid NOT NULL,
 step_index integer NOT NULL CHECK(step_index BETWEEN 0 AND 15),consumption_id text NOT NULL,effect_id uuid NOT NULL,domain_action_id uuid NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=131072),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,obligation_id),UNIQUE(tenant_id,programme_id,step_index),UNIQUE(tenant_id,consumption_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,programme_id) REFERENCES finnor_os.s4_economic_programmes(tenant_id,id),
 FOREIGN KEY(tenant_id,consumption_id) REFERENCES finnor_os.s5_consumptions(tenant_id,consumption_id),
 FOREIGN KEY(tenant_id,effect_id) REFERENCES finnor_os.business_effects(tenant_id,id),
 FOREIGN KEY(tenant_id,domain_action_id) REFERENCES finnor_os.domain_actions(tenant_id,id)
);
ALTER TABLE finnor_os.s5_reservations ADD COLUMN economic_state jsonb
 CHECK(economic_state IS NULL OR octet_length(economic_state::text)<=131072);
CREATE INDEX y1_work ON finnor_os.y1_requests(tenant_id,principal_id,work_id,created_at DESC,id DESC);
CREATE INDEX s6_economic_programme ON finnor_os.s6_economic_obligation_origins(tenant_id,programme_id,step_index);
CREATE FUNCTION finnor_os.y1_original_episode() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF to_jsonb(NEW)-ARRAY['attempts_used','search_steps_used','semantic_applications_used','retained_bytes','event_count','uses_used']
 IS DISTINCT FROM to_jsonb(OLD)-ARRAY['attempts_used','search_steps_used','semantic_applications_used','retained_bytes','event_count','uses_used']
 OR NEW.attempts_used<OLD.attempts_used OR NEW.search_steps_used<OLD.search_steps_used
 OR NEW.semantic_applications_used<OLD.semantic_applications_used OR NEW.retained_bytes<OLD.retained_bytes
 OR NEW.event_count<OLD.event_count OR NEW.uses_used<OLD.uses_used
 THEN RAISE EXCEPTION 'Y1 original Work, deadline and resource counters cannot reset'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER y1_episode_original BEFORE UPDATE ON finnor_os.y1_episodes FOR EACH ROW EXECUTE FUNCTION finnor_os.y1_original_episode();
CREATE FUNCTION finnor_os.y1_request_progress() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Y1 responsibility cannot disappear'; END IF;
 IF to_jsonb(NEW)-ARRAY['status','generation','candidate','construction','artifact','admission','cancelled']
 IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','generation','candidate','construction','artifact','admission','cancelled']
 OR NEW.generation<OLD.generation OR OLD.cancelled AND NOT NEW.cancelled
 OR OLD.candidate IS NOT NULL AND NEW.candidate IS DISTINCT FROM OLD.candidate
 OR OLD.artifact IS NOT NULL AND NEW.artifact IS DISTINCT FROM OLD.artifact
 OR OLD.admission IS NOT NULL AND NEW.admission IS DISTINCT FROM OLD.admission
 THEN RAISE EXCEPTION 'Y1 original inputs and published preimages are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER y1_request_progress BEFORE UPDATE OR DELETE ON finnor_os.y1_requests FOR EACH ROW EXECUTE FUNCTION finnor_os.y1_request_progress();
CREATE FUNCTION finnor_os.y1_storage() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE delta bigint; original_episode uuid;
BEGIN
 IF TG_TABLE_NAME IN('y1_requests','y1_events','s4_economic_programmes') THEN original_episode:=NEW.episode_id;
 ELSIF TG_TABLE_NAME='s8_economic_theory_admissions' THEN
  SELECT episode_id INTO STRICT original_episode FROM finnor_os.y1_requests WHERE tenant_id=NEW.tenant_id AND id=NEW.theory_id;
 ELSE
  SELECT episode_id INTO STRICT original_episode FROM finnor_os.s4_economic_programmes WHERE tenant_id=NEW.tenant_id AND id=NEW.programme_id;
 END IF;
 delta:=octet_length(to_jsonb(NEW)::text)+512;
 IF TG_OP='UPDATE' THEN
  -- Initial metadata occupation covers all bounded status/generation changes.
  delta:=greatest(0,octet_length((to_jsonb(NEW)-ARRAY['status','generation','cancelled'])::text)
   -octet_length((to_jsonb(OLD)-ARRAY['status','generation','cancelled'])::text));
 END IF;
 UPDATE finnor_os.y1_episodes SET retained_bytes=retained_bytes+delta,
  event_count=event_count+CASE WHEN TG_TABLE_NAME='y1_events' THEN 1 ELSE 0 END
 WHERE tenant_id=NEW.tenant_id AND id=original_episode;
 RETURN NEW;
END $$;
CREATE TRIGGER y1_request_storage AFTER INSERT OR UPDATE ON finnor_os.y1_requests FOR EACH ROW EXECUTE FUNCTION finnor_os.y1_storage();
CREATE TRIGGER y1_event_storage AFTER INSERT ON finnor_os.y1_events FOR EACH ROW EXECUTE FUNCTION finnor_os.y1_storage();
CREATE TRIGGER y1_admission_storage AFTER INSERT ON finnor_os.s8_economic_theory_admissions FOR EACH ROW EXECUTE FUNCTION finnor_os.y1_storage();
CREATE TRIGGER y1_programme_storage AFTER INSERT ON finnor_os.s4_economic_programmes FOR EACH ROW EXECUTE FUNCTION finnor_os.y1_storage();
CREATE TRIGGER y1_origin_storage AFTER INSERT ON finnor_os.s6_economic_obligation_origins FOR EACH ROW EXECUTE FUNCTION finnor_os.y1_storage();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['y1_episodes','y1_requests','y1_events','s8_economic_theory_admissions','s4_economic_programmes','s6_economic_obligation_origins'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY y1_tenant ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id()) WITH CHECK(tenant_id=finnor_os.request_tenant_id())',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  IF t IN('y1_episodes','y1_requests') THEN
   EXECUTE format('GRANT UPDATE ON finnor_os.%I TO finnor_app',t);
  ELSE
   EXECUTE format('CREATE TRIGGER y1_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.s5_immutable_record()',t);
  END IF;
 END LOOP;
END $$;
GRANT USAGE,SELECT ON SEQUENCE finnor_os.y1_events_id_seq TO finnor_app;
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('construct_economic_action_theory_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'Y1 finite economic semantic construction and independent data-only checker under the original Work episode; no protected or external effects.');
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_economic_programme_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'Exact internal economic reservation-right transitions; original native S6 effects and independent canonical S7 observation, never external effects.');
INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
 VALUES('native:y1-construction',1,1,0,150,'One bounded Y1 constructor and independent checker stack per original tenant episode');
INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
 VALUES('native:y1-owner',1,1,0,150,'One bounded internal Y1 owner delivery and reconciliation stack');
ALTER TABLE finnor_os.work_query_executions DROP CONSTRAINT work_query_executions_intent_check;
ALTER TABLE finnor_os.work_query_executions ADD CONSTRAINT work_query_executions_intent_check CHECK(intent IN(
 'work_list','attention_queue','agent_activity','workforce_status','company_context','party_lookup','party_context','team_roster',
 'pe_world_state','deal_context','deal_workstreams','open_requests','open_findings','open_deal_risks','critical_dependencies','closing_readiness','harness_program_v1','economic_programme_v1'));

-- Maintained P7 invalidation runs in the canonical input mutation transaction.
-- It changes only the mutable head; admitted and prepared preimages survive.
-- Detailed affected closure is appended by the bounded owner read/worker.
CREATE FUNCTION finnor_os.y1_input_changed() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE tenant uuid; subject uuid;
BEGIN
 tenant:=coalesce(NEW.tenant_id,OLD.tenant_id);
 IF TG_TABLE_NAME='work_inputs' THEN
  subject:=coalesce(NEW.work_id,OLD.work_id);
  UPDATE finnor_os.y1_requests SET status='INVALIDATED',generation=generation+1
   WHERE tenant_id=tenant AND work_id=subject AND work_input_id<>NEW.id AND status<>'INVALIDATED' AND NOT cancelled;
 ELSIF TG_TABLE_NAME='evidence_source_versions' THEN
  subject:=coalesce(NEW.source_id,OLD.source_id);
  UPDATE finnor_os.y1_requests r SET status='INVALIDATED',generation=generation+1
   WHERE r.tenant_id=tenant AND r.status<>'INVALIDATED' AND NOT r.cancelled
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.request->'problem'->'meanings') m WHERE m->>'sourceId'=subject::text AND m->>'versionId'<>NEW.id::text);
 ELSE
  UPDATE finnor_os.y1_requests SET status='INVALIDATED',generation=generation+1
   WHERE tenant_id=tenant AND status<>'INVALIDATED' AND NOT cancelled;
 END IF;
 RETURN coalesce(NEW,OLD);
END $$;
CREATE TRIGGER y1_work_changed AFTER INSERT ON finnor_os.work_inputs FOR EACH ROW EXECUTE FUNCTION finnor_os.y1_input_changed();
CREATE TRIGGER y1_meaning_changed AFTER INSERT ON finnor_os.evidence_source_versions FOR EACH ROW EXECUTE FUNCTION finnor_os.y1_input_changed();
CREATE TRIGGER y1_authority_changed AFTER UPDATE ON finnor_os.authority_states FOR EACH ROW EXECUTE FUNCTION finnor_os.y1_input_changed();

CREATE FUNCTION finnor_os.y1_native_intent_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_TABLE_NAME='business_effects' THEN
  IF NOT EXISTS(SELECT 1 FROM finnor_os.s6_economic_obligation_origins WHERE tenant_id=OLD.tenant_id AND effect_id=OLD.id) THEN RETURN coalesce(NEW,OLD); END IF;
  IF TG_OP='DELETE' OR to_jsonb(NEW)-ARRAY['status','observed_result','verification','authorized_at','execution_started_at','observed_at']
   IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','observed_result','verification','authorized_at','execution_started_at','observed_at']
   OR OLD.observed_result IS NOT NULL AND NEW.observed_result IS DISTINCT FROM OLD.observed_result
   OR OLD.verification IS NOT NULL AND NEW.verification IS DISTINCT FROM OLD.verification
   OR OLD.status='verified' AND NEW.status IS DISTINCT FROM OLD.status
   OR OLD.observed_at IS NOT NULL AND NEW.observed_at IS DISTINCT FROM OLD.observed_at
  THEN RAISE EXCEPTION 'Y1 native economic effect intent and observations cannot be substituted'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM finnor_os.s6_economic_obligation_origins WHERE tenant_id=OLD.tenant_id AND domain_action_id=OLD.id) THEN RETURN coalesce(NEW,OLD); END IF;
  IF TG_OP='DELETE' OR NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.action_type<>OLD.action_type
   OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.business_effect_id IS DISTINCT FROM OLD.business_effect_id
   OR NEW.work_id IS DISTINCT FROM OLD.work_id OR NEW.plan_revision_id IS DISTINCT FROM OLD.plan_revision_id
   OR NEW.plan_node_id IS DISTINCT FROM OLD.plan_node_id OR NEW.initiated_by IS DISTINCT FROM OLD.initiated_by
   OR OLD.status='completed' AND NEW.status IS DISTINCT FROM OLD.status
  THEN RAISE EXCEPTION 'Y1 native economic action identity and payload cannot be substituted'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER y1_native_intent_guard BEFORE UPDATE OR DELETE ON finnor_os.business_effects FOR EACH ROW EXECUTE FUNCTION finnor_os.y1_native_intent_guard();
CREATE TRIGGER y1_native_intent_guard BEFORE UPDATE OR DELETE ON finnor_os.domain_actions FOR EACH ROW EXECUTE FUNCTION finnor_os.y1_native_intent_guard();
