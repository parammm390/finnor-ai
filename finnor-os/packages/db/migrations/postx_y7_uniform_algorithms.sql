CREATE TABLE finnor_os.y5_discoveries(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,id uuid NOT NULL,work_id uuid NOT NULL,
 root_type text NOT NULL,root_id uuid NOT NULL,episode_id text NOT NULL,
 request jsonb NOT NULL CHECK(octet_length(request::text)<=2097152),request_digest text NOT NULL,
 binding jsonb NOT NULL CHECK(octet_length(binding::text)<=4194304),deadline_at timestamptz NOT NULL,
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
 attempt_count integer NOT NULL DEFAULT 0,max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 1 AND 2),
 use_count integer NOT NULL DEFAULT 0,max_uses integer NOT NULL CHECK(max_uses BETWEEN 1 AND 16),
 data_bytes bigint NOT NULL DEFAULT 0 CHECK(data_bytes BETWEEN 0 AND 67108864),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','RUNNING','CHECKED','INCOMPLETE','UNKNOWN','CANCELLED','INVALIDATED')),
 result_digest text,idempotency_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,principal_id,id),UNIQUE(tenant_id,principal_id,idempotency_key),
 UNIQUE(tenant_id,principal_id,work_id),UNIQUE(tenant_id,principal_id,episode_id),
 CHECK(attempt_count BETWEEN 0 AND max_attempts),CHECK(use_count BETWEEN 0 AND max_uses),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id)
);
CREATE TABLE finnor_os.y5_capsules(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,discovery_id uuid NOT NULL,content_digest text NOT NULL CHECK(content_digest~'^[a-f0-9]{64}$'),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=16777216),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,discovery_id,content_digest),
 FOREIGN KEY(tenant_id,principal_id,discovery_id) REFERENCES finnor_os.y5_discoveries(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.y5_uses(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,id uuid NOT NULL,discovery_id uuid NOT NULL,idempotency_key text NOT NULL,
 request jsonb NOT NULL CHECK(octet_length(request::text)<=2097152),request_digest text NOT NULL,deadline_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN('STARTED','COMPLETE')),body jsonb CHECK(octet_length(body::text)<=16777216),content_digest text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,principal_id,discovery_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id,discovery_id) REFERENCES finnor_os.y5_discoveries(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.y5_events(
 id bigserial PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,discovery_id uuid NOT NULL,
 event_key text NOT NULL,kind text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=16777216),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,discovery_id,event_key),
 FOREIGN KEY(tenant_id,principal_id,discovery_id) REFERENCES finnor_os.y5_discoveries(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.y5_evaluations(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,id uuid NOT NULL,discovery_id uuid NOT NULL,evaluator_id uuid NOT NULL,
 capsule_digest text NOT NULL,assignment jsonb NOT NULL,assignment_digest text NOT NULL,request_digest text NOT NULL,idempotency_key text NOT NULL,
 result jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,principal_id,discovery_id,idempotency_key),CHECK(evaluator_id<>principal_id),
 FOREIGN KEY(tenant_id,principal_id,discovery_id) REFERENCES finnor_os.y5_discoveries(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,evaluator_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE INDEX y5_work ON finnor_os.y5_discoveries(tenant_id,principal_id,work_id,created_at,id);
CREATE INDEX y5_history ON finnor_os.y5_events(tenant_id,principal_id,discovery_id,id);
CREATE FUNCTION finnor_os.y5_original_responsibility() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF to_jsonb(NEW)-ARRAY['attempt_count','use_count','data_bytes','generation','status','result_digest']
 IS DISTINCT FROM to_jsonb(OLD)-ARRAY['attempt_count','use_count','data_bytes','generation','status','result_digest']
 OR NEW.attempt_count<OLD.attempt_count OR NEW.use_count<OLD.use_count OR NEW.data_bytes<OLD.data_bytes OR NEW.generation<OLD.generation
 OR OLD.status IN('CANCELLED','INVALIDATED') AND NEW.status<>OLD.status
 OR OLD.result_digest IS NOT NULL AND NEW.result_digest IS DISTINCT FROM OLD.result_digest
 THEN RAISE EXCEPTION 'Y5 original identity/budget cannot reset'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION finnor_os.y5_use_once() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF to_jsonb(NEW)-ARRAY['status','body','content_digest'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','body','content_digest']
 OR OLD.status<>'STARTED' OR NEW.status<>'COMPLETE' OR NEW.body IS NULL OR NEW.content_digest IS NULL
 THEN RAISE EXCEPTION 'Y5 original use/outcome cannot change'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER y5_allocation BEFORE UPDATE ON finnor_os.y5_discoveries FOR EACH ROW EXECUTE FUNCTION finnor_os.y5_original_responsibility();
CREATE TRIGGER y5_use_once BEFORE UPDATE ON finnor_os.y5_uses FOR EACH ROW EXECUTE FUNCTION finnor_os.y5_use_once();
CREATE FUNCTION finnor_os.y5_evaluation_once() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF to_jsonb(NEW)-'result' IS DISTINCT FROM to_jsonb(OLD)-'result' OR OLD.result IS NOT NULL OR NEW.result IS NULL
 THEN RAISE EXCEPTION 'Y5 registered evaluation identity/outcome cannot change'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER y5_evaluation_once BEFORE UPDATE ON finnor_os.y5_evaluations FOR EACH ROW EXECUTE FUNCTION finnor_os.y5_evaluation_once();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['y5_discoveries','y5_capsules','y5_uses','y5_events'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY y5_principal ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('REVOKE ALL ON finnor_os.%I FROM finnor_app',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  IF t IN('y5_discoveries','y5_uses') THEN
   EXECUTE format('GRANT UPDATE ON finnor_os.%I TO finnor_app',t);
  ELSE
   EXECUTE format('CREATE TRIGGER y5_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.m3_immutable()',t);
  END IF;
 END LOOP;
END $$;
ALTER TABLE finnor_os.y5_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.y5_evaluations FORCE ROW LEVEL SECURITY;
CREATE POLICY y5_evaluation_participants ON finnor_os.y5_evaluations
 USING(tenant_id=finnor_os.request_tenant_id() AND nullif(current_setting('app.user_id',true),'')::uuid IN(principal_id,evaluator_id))
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND nullif(current_setting('app.user_id',true),'')::uuid IN(principal_id,evaluator_id));
REVOKE ALL ON finnor_os.y5_evaluations FROM finnor_app;
GRANT SELECT,INSERT,UPDATE ON finnor_os.y5_evaluations TO finnor_app;
CREATE FUNCTION finnor_os.y5_retained_storage() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE allocation_id uuid; delta bigint;
BEGIN
 IF TG_TABLE_NAME='y5_discoveries' THEN allocation_id:=NEW.id; ELSE allocation_id:=NEW.discovery_id; END IF;
 delta:=octet_length(to_jsonb(NEW)::text);
 IF TG_OP='UPDATE' THEN delta:=greatest(0,delta-octet_length(to_jsonb(OLD)::text)); END IF;
 IF delta>0 THEN UPDATE finnor_os.y5_discoveries SET data_bytes=data_bytes+delta WHERE tenant_id=NEW.tenant_id AND id=allocation_id; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER y5_storage AFTER INSERT ON finnor_os.y5_discoveries FOR EACH ROW EXECUTE FUNCTION finnor_os.y5_retained_storage();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['y5_capsules','y5_uses','y5_events','y5_evaluations'] LOOP
  EXECUTE format('CREATE TRIGGER y5_storage AFTER INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.y5_retained_storage()',t);
 END LOOP;
END $$;
GRANT USAGE,SELECT ON SEQUENCE finnor_os.y5_events_id_seq TO finnor_app;
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('discover_uniform_algorithm_v1','HEAVY',ARRAY['HEAVY'],'fixed','tenant','required',1,'Y5 bounded closed-syntax native proof search and independent checking; original deadline and physical fences, no protected authority.');
INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
 VALUES('native:y5-proof',1,1,0,90,'Y5 serial proof construction, kernel replay and same-definition execution; no aggregate memory qualification');
