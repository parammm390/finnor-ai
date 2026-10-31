-- W2 owns contract revisions and responsibility projections. Identity, evidence,
-- original Work, S5 resources, S6 effects and the physical queue stay native.
CREATE TABLE finnor_os.w2_programs(
 tenant_id uuid NOT NULL,id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,work_input_id uuid NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 240),request_digest text NOT NULL,
 original_digest text NOT NULL,original jsonb NOT NULL CHECK(octet_length(original::text)<=2097152),
 budget jsonb NOT NULL CHECK(octet_length(budget::text)<=8388608),
 status text NOT NULL CHECK(status IN('QUEUED','COMPILING','ACTIVE','PARTIAL','BLOCKED','FENCED','CLOSED')),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),program jsonb CHECK(octet_length(program::text)<=8388608),
 compile_result jsonb,job_id uuid,claim_token uuid,claim_fence bigint,last_error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,principal_id,idempotency_key),UNIQUE(tenant_id,work_input_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id)
);
CREATE INDEX w2_program_work ON finnor_os.w2_programs(tenant_id,principal_id,work_id,created_at,id);
CREATE TABLE finnor_os.w2_program_revisions(
 tenant_id uuid NOT NULL,program_id uuid NOT NULL,principal_id uuid NOT NULL,revision integer NOT NULL,
 program jsonb NOT NULL CHECK(octet_length(program::text)<=8388608),check_result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,program_id,revision),
 FOREIGN KEY(tenant_id,program_id) REFERENCES finnor_os.w2_programs(tenant_id,id)
);
CREATE TABLE finnor_os.w2_assignment_heads(
 tenant_id uuid NOT NULL,program_id uuid NOT NULL,assignment_id text NOT NULL,principal_id uuid NOT NULL,
 actor_id uuid NOT NULL,recipient_principal_id uuid NOT NULL,work_id uuid NOT NULL,
 slot_start timestamptz NOT NULL,slot_end timestamptz NOT NULL CHECK(slot_end>slot_start),
 effort_seconds text NOT NULL CHECK(length(effort_seconds)<=192 AND
   effort_seconds ~ '^([0-9]+([.][0-9]+)?|[0-9]+/[1-9][0-9]*)$'),holds_capacity boolean NOT NULL DEFAULT false,
 state text NOT NULL,revision integer NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=262144),
 task jsonb NOT NULL CHECK(octet_length(task::text)<=262144),
 PRIMARY KEY(tenant_id,program_id,assignment_id),
 FOREIGN KEY(tenant_id,program_id) REFERENCES finnor_os.w2_programs(tenant_id,id),
 FOREIGN KEY(tenant_id,recipient_principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id)
);
CREATE INDEX w2_actor_capacity ON finnor_os.w2_assignment_heads(tenant_id,actor_id,slot_start,slot_end) WHERE holds_capacity;
CREATE INDEX w2_recipient_work ON finnor_os.w2_assignment_heads(tenant_id,recipient_principal_id,work_id,program_id,assignment_id);
CREATE TABLE finnor_os.w2_events(
 tenant_id uuid NOT NULL,program_id uuid NOT NULL,principal_id uuid NOT NULL,event_id text NOT NULL,kind text NOT NULL,
 request_digest text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,program_id,event_id),
 FOREIGN KEY(tenant_id,program_id) REFERENCES finnor_os.w2_programs(tenant_id,id)
);
CREATE INDEX w2_events_kind ON finnor_os.w2_events(tenant_id,program_id,kind,created_at,event_id);
CREATE TABLE finnor_os.w2_dependencies(
 tenant_id uuid NOT NULL,program_id uuid NOT NULL,principal_id uuid NOT NULL,source_kind text NOT NULL,source_id text NOT NULL,
 source_digest text NOT NULL,assignment_ids jsonb NOT NULL,
 PRIMARY KEY(tenant_id,program_id,source_kind,source_id),
 FOREIGN KEY(tenant_id,program_id) REFERENCES finnor_os.w2_programs(tenant_id,id)
);

CREATE FUNCTION finnor_os.w2_immutable() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,finnor_os AS $$
BEGIN RAISE EXCEPTION 'W2 original contract/evidence history is append-only'; END $$;
CREATE TRIGGER w2_history_immutable BEFORE UPDATE OR DELETE ON finnor_os.w2_program_revisions
 FOR EACH ROW EXECUTE FUNCTION finnor_os.w2_immutable();
CREATE TRIGGER w2_event_immutable BEFORE UPDATE OR DELETE ON finnor_os.w2_events
 FOR EACH ROW EXECUTE FUNCTION finnor_os.w2_immutable();
CREATE FUNCTION finnor_os.w2_original_fence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'W2 responsibility cannot disappear'; END IF;
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.principal_id<>OLD.principal_id OR NEW.work_id<>OLD.work_id
  OR NEW.work_input_id<>OLD.work_input_id OR NEW.original_digest<>OLD.original_digest OR NEW.original<>OLD.original
  OR NEW.budget<>OLD.budget OR NEW.request_digest<>OLD.request_digest OR NEW.idempotency_key<>OLD.idempotency_key
  OR NEW.revision<OLD.revision
  OR (NEW.program IS NOT NULL AND NEW.revision<>(NEW.program->>'revision')::integer)
 THEN RAISE EXCEPTION 'W2 original root, budget, deadline and revision cannot reset'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER w2_original_fence BEFORE UPDATE OR DELETE ON finnor_os.w2_programs
 FOR EACH ROW EXECUTE FUNCTION finnor_os.w2_original_fence();

DO $$ DECLARE tab text;role_name text; BEGIN
 FOREACH tab IN ARRAY ARRAY['w2_programs','w2_program_revisions','w2_assignment_heads','w2_events','w2_dependencies'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY w2_owner_private ON finnor_os.%I USING(
    tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)
    WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',tab);
  FOREACH role_name IN ARRAY ARRAY['finnor_app','finnor_worker'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON finnor_os.%I TO %I',tab,role_name);
   END IF;
  END LOOP;
 END LOOP;
END $$;
CREATE POLICY w2_recipient_private ON finnor_os.w2_assignment_heads FOR SELECT USING(
 tenant_id=finnor_os.request_tenant_id() AND recipient_principal_id=nullif(current_setting('app.user_id',true),'')::uuid);

-- A recipient cannot read a parent programme's private JSON. This projection
-- returns only metadata and the recipient's own exact assignment/task.
CREATE FUNCTION finnor_os.w2_recipient_program(p_program uuid) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT jsonb_build_object('id',p.id,'workId',p.work_id,'status',p.status,'revision',p.revision,
   'assignments',jsonb_agg(jsonb_build_object('assignment',h.body,'task',h.task) ORDER BY h.assignment_id))
 FROM finnor_os.w2_programs p JOIN finnor_os.w2_assignment_heads h ON h.tenant_id=p.tenant_id AND h.program_id=p.id
 JOIN finnor_os.users u ON u.tenant_id=h.tenant_id AND u.id=h.recipient_principal_id AND u.status='active'
 WHERE p.tenant_id=finnor_os.request_tenant_id() AND p.id=p_program
  AND h.recipient_principal_id=nullif(current_setting('app.user_id',true),'')::uuid
 GROUP BY p.id,p.work_id,p.status,p.revision
$$;
-- A checker gets only an opaque access binding here. The runtime rechecks the
-- canonical identity/grants and returns only its own pending review, not the
-- accountable root, another producer's offer, or the hidden whole graph.
CREATE FUNCTION finnor_os.w2_participant_access(p_program uuid,p_assignment text) RETURNS uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT p.principal_id FROM finnor_os.w2_programs p
 JOIN finnor_os.w2_assignment_heads h ON h.tenant_id=p.tenant_id AND h.program_id=p.id
 JOIN finnor_os.users u ON u.tenant_id=p.tenant_id
  AND u.id=nullif(current_setting('app.user_id',true),'')::uuid AND u.status='active'
 WHERE p.tenant_id=finnor_os.request_tenant_id() AND p.id=p_program
  AND (p_assignment IS NULL OR h.assignment_id=p_assignment)
  AND (h.recipient_principal_id=u.id OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(p.original->'outcome'->'criteria') criterion
   WHERE criterion->>'id'=h.task->>'criterionId' AND criterion->>'checkerActorId'=u.id::text))
 LIMIT 1
$$;
CREATE FUNCTION finnor_os.w2_participant_programs(p_work uuid) RETURNS TABLE(id uuid,work_id uuid)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT DISTINCT p.id,p.work_id FROM finnor_os.w2_programs p
 JOIN finnor_os.w2_assignment_heads h ON h.tenant_id=p.tenant_id AND h.program_id=p.id
 JOIN finnor_os.users u ON u.tenant_id=p.tenant_id
  AND u.id=nullif(current_setting('app.user_id',true),'')::uuid AND u.status='active'
 WHERE p.tenant_id=finnor_os.request_tenant_id() AND p.work_id=p_work
  AND (h.recipient_principal_id=u.id OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(p.original->'outcome'->'criteria') criterion
   WHERE criterion->>'id'=h.task->>'criterionId' AND criterion->>'checkerActorId'=u.id::text))
 ORDER BY p.id LIMIT 129
$$;
-- Opaque canonical schedule occupation, not another Work's confidential body.
CREATE FUNCTION finnor_os.w2_actor_occupation(p_actors uuid[],p_exclude uuid)
 RETURNS TABLE(actor_id uuid,slot_start timestamptz,slot_end timestamptz,effort_seconds text)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF array_length(p_actors,1)>128 OR finnor_os.request_tenant_id() IS NULL THEN
  RAISE EXCEPTION 'W2 complete actor occupation profile required';
 END IF;
 RETURN QUERY SELECT h.actor_id,h.slot_start,h.slot_end,h.effort_seconds::text
  FROM finnor_os.w2_assignment_heads h WHERE h.tenant_id=finnor_os.request_tenant_id()
   AND h.actor_id=ANY(p_actors) AND h.program_id<>p_exclude AND h.holds_capacity
  ORDER BY h.actor_id,h.slot_start,h.slot_end LIMIT 4097;
END $$;
REVOKE ALL ON FUNCTION finnor_os.w2_recipient_program(uuid),finnor_os.w2_actor_occupation(uuid[],uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.w2_participant_access(uuid,text),finnor_os.w2_participant_programs(uuid) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['finnor_app','finnor_worker'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION finnor_os.w2_recipient_program(uuid),finnor_os.w2_actor_occupation(uuid[],uuid) TO %I',role_name);
   EXECUTE format('GRANT EXECUTE ON FUNCTION finnor_os.w2_participant_access(uuid,text),finnor_os.w2_participant_programs(uuid) TO %I',role_name);
  END IF;
 END LOOP;
END $$;
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_workforce_execution_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'W2 whole original Work graph, separately resolved checking, authenticated exact contract events and original S5/S6 responsibility; no protected delegated-child authority.');
