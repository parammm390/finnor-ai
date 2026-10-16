-- Base-local successor of main 0171. NOT a reserved joined R1/R2/R4 ordinal.
-- A serial integration must assign a unique ordered name and rerun migrate/guards.
CREATE TABLE finnor_os.r3_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
 principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 work_id uuid NOT NULL REFERENCES finnor_os.works(id),
 work_input_id uuid NOT NULL,
 idempotency_key text NOT NULL,
 request_digest text NOT NULL,
 request jsonb NOT NULL,
 problem jsonb NOT NULL,
 binding jsonb NOT NULL,
 deadline_at timestamptz NOT NULL,
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN
  ('QUEUED','RUNNING','COMPLETE','INCOMPLETE','INFEASIBLE','UNSUPPORTED','UNKNOWN','CANCELLED','INVALIDATED')),
 attempts_used integer NOT NULL DEFAULT 0 CHECK(attempts_used>=0),
 protocol_ref jsonb,
 use_policy_ref jsonb,
 allocation_ref jsonb,
 schedules_ref jsonb,
 closed_event_id text,
 claim_token uuid,
 claim_fence bigint,
 failure text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,idempotency_key),
 UNIQUE(tenant_id,id)
);
CREATE INDEX r3_work_current ON finnor_os.r3_requests(tenant_id,principal_id,work_id,created_at DESC,id);
CREATE TABLE finnor_os.r3_objects (
 tenant_id uuid NOT NULL,
 principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 request_id uuid NOT NULL,
 owner text NOT NULL,
 object_id text NOT NULL,
 version text NOT NULL,
 digest text NOT NULL,
 body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,object_id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.r3_requests(tenant_id,id)
);
CREATE TABLE finnor_os.r3_events (
 tenant_id uuid NOT NULL,
 principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 request_id uuid NOT NULL,
 event_id text NOT NULL,
 generation integer NOT NULL,
 kind text NOT NULL,
 body jsonb NOT NULL,
 digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,event_id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.r3_requests(tenant_id,id)
);
CREATE INDEX r3_event_history ON finnor_os.r3_events(tenant_id,request_id,created_at,event_id);
CREATE TABLE finnor_os.r3_dependencies (
 tenant_id uuid NOT NULL,
 request_id uuid NOT NULL,
 key text NOT NULL,
 revision bigint NOT NULL,
 PRIMARY KEY(tenant_id,request_id,key),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.r3_requests(tenant_id,id)
);
CREATE TABLE finnor_os.r3_attempts (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 request_id uuid NOT NULL,
 delivery_id uuid NOT NULL,
 phase text NOT NULL CHECK(phase IN ('PRODUCER','CHECKER','FALLBACK')),
 status text NOT NULL CHECK(status IN ('INTENT','SUBMITTED','RETURNED','ACCEPTED','FAILED','UNKNOWN','LATE','CANCELLED')),
 claim_fence bigint NOT NULL,
 body jsonb NOT NULL,
 digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,delivery_id,phase),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.r3_requests(tenant_id,id)
);
CREATE FUNCTION finnor_os.r3_immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'R3 original input/history is append-only'; END $$;
CREATE TRIGGER r3_objects_immutable BEFORE UPDATE OR DELETE ON finnor_os.r3_objects
 FOR EACH ROW EXECUTE FUNCTION finnor_os.r3_immutable_record();
CREATE TRIGGER r3_events_immutable BEFORE UPDATE OR DELETE ON finnor_os.r3_events
 FOR EACH ROW EXECUTE FUNCTION finnor_os.r3_immutable_record();
CREATE FUNCTION finnor_os.r3_original_input_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.tenant_id,NEW.principal_id,NEW.work_id,NEW.work_input_id,NEW.request_digest,NEW.request,NEW.problem,NEW.binding,NEW.deadline_at)
   IS DISTINCT FROM ROW(OLD.tenant_id,OLD.principal_id,OLD.work_id,OLD.work_input_id,OLD.request_digest,OLD.request,OLD.problem,OLD.binding,OLD.deadline_at)
 THEN RAISE EXCEPTION 'R3 original input and deadline are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER r3_requests_original_fence BEFORE UPDATE ON finnor_os.r3_requests
 FOR EACH ROW EXECUTE FUNCTION finnor_os.r3_original_input_fence();
CREATE FUNCTION finnor_os.r3_attempt_origin_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status IN('RETURNED','ACCEPTED','FAILED','UNKNOWN','LATE','CANCELLED') THEN
  RAISE EXCEPTION 'R3 terminal native receipt and responsibility are immutable';
 END IF;
 IF ROW(NEW.id,NEW.tenant_id,NEW.principal_id,NEW.request_id,NEW.delivery_id,NEW.phase,NEW.claim_fence,
        NEW.body->'originalEpisode',NEW.body->'originalDeadlineAt',NEW.body->'originalGrant',
        NEW.body->'inputDigest',NEW.body->'runtimeDigest',NEW.body->'chargedInvocations')
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.principal_id,OLD.request_id,OLD.delivery_id,OLD.phase,OLD.claim_fence,
        OLD.body->'originalEpisode',OLD.body->'originalDeadlineAt',OLD.body->'originalGrant',
        OLD.body->'inputDigest',OLD.body->'runtimeDigest',OLD.body->'chargedInvocations')
 THEN RAISE EXCEPTION 'R3 native attempt origin and debit cannot change'; END IF;
 IF NEW.status NOT IN('SUBMITTED','RETURNED','ACCEPTED','FAILED','UNKNOWN','LATE','CANCELLED')
 THEN RAISE EXCEPTION 'R3 native attempt cannot regress to intent'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER r3_attempt_origin_fence BEFORE UPDATE OR DELETE ON finnor_os.r3_attempts
 FOR EACH ROW EXECUTE FUNCTION finnor_os.r3_attempt_origin_fence();
DO $policies$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['r3_requests','r3_objects','r3_events','r3_attempts','r3_dependencies'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_isolation ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id()) WITH CHECK(tenant_id=finnor_os.request_tenant_id())',name);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON finnor_os.%I TO finnor_app',name);
 END LOOP;
END $policies$;
-- P7's shared revision owner closes only explicitly registered R3 keys.
-- Existing agreements, effects, reservations, events and costs are never erased.
CREATE FUNCTION finnor_os.r3_revision_closure() RETURNS trigger LANGUAGE plpgsql
 SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.revision=0 THEN RETURN NULL; END IF;
 IF TG_OP='UPDATE' AND NEW.revision=OLD.revision THEN RETURN NULL; END IF;
 UPDATE finnor_os.r3_requests q SET status='INVALIDATED',generation=generation+1,
  failure='R3_DEPENDENCY_REVISED:'||NEW.key,updated_at=clock_timestamp()
 WHERE q.tenant_id=NEW.tenant_id AND q.status IN('QUEUED','RUNNING','COMPLETE','INCOMPLETE')
  AND EXISTS(SELECT 1 FROM finnor_os.r3_dependencies d WHERE d.tenant_id=q.tenant_id
   AND d.request_id=q.id AND d.key=NEW.key AND d.revision<>NEW.revision);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION finnor_os.r3_revision_closure() FROM PUBLIC;
CREATE TRIGGER r3_revision_closure AFTER INSERT OR UPDATE ON finnor_os.p4_source_revisions
 FOR EACH ROW EXECUTE FUNCTION finnor_os.r3_revision_closure();
CREATE FUNCTION finnor_os.r3_source_revision() RETURNS trigger LANGUAGE plpgsql
 SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE j jsonb;t uuid;k text;
BEGIN
 j:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 t:=(j->>'tenant_id')::uuid;
 IF t IS NULL THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='s5_resource_heads' THEN k:='r3:resource:'||(j->>'resource_id');
 ELSIF TG_TABLE_NAME='s5_reservations' THEN k:='r3:reservation:'||(j->>'reservation_id');
 ELSIF TG_TABLE_NAME='work_plan_revisions' THEN k:='r3:plan:'||(j->>'work_id');
 ELSE RETURN NULL;
 END IF;
 PERFORM finnor_os.p4_touch_source(t,k);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION finnor_os.r3_source_revision() FROM PUBLIC;
CREATE TRIGGER r3_source_revision AFTER INSERT OR UPDATE OR DELETE ON finnor_os.s5_resource_heads
 FOR EACH ROW EXECUTE FUNCTION finnor_os.r3_source_revision();
CREATE TRIGGER r3_source_revision AFTER INSERT OR UPDATE OR DELETE ON finnor_os.s5_reservations
 FOR EACH ROW EXECUTE FUNCTION finnor_os.r3_source_revision();
CREATE TRIGGER r3_source_revision AFTER INSERT OR UPDATE OR DELETE ON finnor_os.work_plan_revisions
 FOR EACH ROW EXECUTE FUNCTION finnor_os.r3_source_revision();
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_incentive_rule_synthesis_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'Complete R3 proposed finite mechanism under original S5 compute grant; no effect or admission')
 ON CONFLICT(job_type) DO NOTHING;
INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
 VALUES('native:r3',1,1,0,60,'R3 scoped native child capacity, not protected funding') ON CONFLICT(resource_key) DO NOTHING;
