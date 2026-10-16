-- Standalone main+R8 only. R1/R2 also propose 0172; the serial owner must
-- allocate/renumber the assembled migration before claiming joined compatibility.
CREATE TABLE finnor_os.r8_grants(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,
 deadline_at timestamptz NOT NULL,max_rounds integer NOT NULL CHECK(max_rounds BETWEEN 2 AND 16),
 rounds_used integer NOT NULL DEFAULT 0 CHECK(rounds_used>=0),attempts_used integer NOT NULL DEFAULT 0 CHECK(attempts_used BETWEEN 0 AND 3),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,principal_id,work_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id)
);
CREATE TABLE finnor_os.r8_requests(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,work_input_id uuid NOT NULL,
 work_input_digest text NOT NULL CHECK(work_input_digest~'^[a-f0-9]{64}$'),
 grant_id uuid NOT NULL REFERENCES finnor_os.r8_grants(id),parent_request_id uuid,
 idempotency_key text NOT NULL,request_digest text NOT NULL CHECK(request_digest~'^[a-f0-9]{64}$'),
 request jsonb NOT NULL CHECK(octet_length(request::text)<=65536),binding jsonb NOT NULL CHECK(octet_length(binding::text)<=8388608),
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','RUNNING','COMPLETE','INCOMPLETE','UNSUPPORTED','UNKNOWN','INVALIDATED','CANCELLED')),
 capsule_digest text,claim_token uuid,claim_fence bigint,failure text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,id),UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id,parent_request_id) REFERENCES finnor_os.r8_requests(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.r8_records(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,request_id uuid NOT NULL,
 category text NOT NULL CHECK(category IN('QUERY','CANDIDATE','TRIAL','CHUNK','CAPSULE','INVOCATION','FALLBACK','PROCESS','RESOURCE','PUBLICATION','INVALIDATION','CANCEL')),
 record_key text NOT NULL,digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=8388608),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,request_id,category,record_key),
 FOREIGN KEY(tenant_id,principal_id,request_id) REFERENCES finnor_os.r8_requests(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.r8_dependencies(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,request_id uuid NOT NULL,key text NOT NULL,revision bigint NOT NULL,
 PRIMARY KEY(tenant_id,principal_id,request_id,key),
 FOREIGN KEY(tenant_id,principal_id,request_id) REFERENCES finnor_os.r8_requests(tenant_id,principal_id,id)
);
CREATE FUNCTION finnor_os.r8_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
 BEGIN RAISE EXCEPTION 'R8 accepted identities and history are immutable; append a new record'; END $$;
CREATE FUNCTION finnor_os.r8_request_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF to_jsonb(NEW)-ARRAY['generation','status','capsule_digest','claim_token','claim_fence','failure','updated_at']
  IS DISTINCT FROM to_jsonb(OLD)-ARRAY['generation','status','capsule_digest','claim_token','claim_fence','failure','updated_at']
  THEN RAISE EXCEPTION 'R8 request cannot substitute inputs or renew original grant'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION finnor_os.r8_grant_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF to_jsonb(NEW)-ARRAY['rounds_used','attempts_used'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['rounds_used','attempts_used']
  OR NEW.rounds_used<OLD.rounds_used OR NEW.attempts_used<OLD.attempts_used OR NEW.rounds_used>NEW.max_rounds
  THEN RAISE EXCEPTION 'R8 original Work episode and incurred debits cannot reset'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER r8_request_guard BEFORE UPDATE ON finnor_os.r8_requests FOR EACH ROW EXECUTE FUNCTION finnor_os.r8_request_guard();
CREATE TRIGGER r8_grant_guard BEFORE UPDATE ON finnor_os.r8_grants FOR EACH ROW EXECUTE FUNCTION finnor_os.r8_grant_guard();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['r8_grants','r8_requests','r8_records','r8_dependencies'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY r8_private_scope ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('REVOKE ALL ON finnor_os.%I FROM finnor_app',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  EXECUTE format('CREATE TRIGGER r8_no_delete BEFORE DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.r8_immutable()',t);
 END LOOP;
 GRANT UPDATE ON finnor_os.r8_grants,finnor_os.r8_requests TO finnor_app;
 CREATE TRIGGER r8_records_immutable BEFORE UPDATE ON finnor_os.r8_records FOR EACH ROW EXECUTE FUNCTION finnor_os.r8_immutable();
 CREATE TRIGGER r8_dependencies_immutable BEFORE UPDATE ON finnor_os.r8_dependencies FOR EACH ROW EXECUTE FUNCTION finnor_os.r8_immutable();
END $$;
CREATE INDEX r8_work_head ON finnor_os.r8_requests(tenant_id,principal_id,work_id,created_at DESC,id DESC);
CREATE FUNCTION finnor_os.r8_touch_source(t uuid,k text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 PERFORM finnor_os.p4_touch_source(t,k);
 UPDATE finnor_os.r8_requests q SET status='INVALIDATED',generation=generation+1,failure='R8_DEPENDENCY_CHANGED',updated_at=clock_timestamp()
 WHERE q.tenant_id=t AND q.status IN('QUEUED','RUNNING','COMPLETE','INCOMPLETE','UNKNOWN') AND EXISTS(
  SELECT 1 FROM finnor_os.r8_dependencies d WHERE d.tenant_id=t AND d.principal_id=q.principal_id AND d.request_id=q.id AND d.key=k);
END $$;
CREATE FUNCTION finnor_os.r8_source_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE j jsonb;t uuid;s jsonb;BEGIN
 j:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;t:=(j->>'tenant_id')::uuid;
 IF t IS NULL THEN RETURN NULL;END IF;
 IF TG_TABLE_NAME='work_inputs' THEN PERFORM finnor_os.r8_touch_source(t,'work-inputs:'||(j->>'work_id'));
 ELSIF TG_TABLE_NAME IN('s5_resource_heads','s5_reservations','s5_consumption_states') THEN PERFORM finnor_os.r8_touch_source(t,'r8:s5-complete');
 ELSIF TG_TABLE_NAME='business_effects' THEN PERFORM finnor_os.r8_touch_source(t,'r8:s6-effects');
 ELSIF TG_TABLE_NAME='canonical_entity_versions' THEN
  s:=j->'snapshot';
  IF s->>'world_root_type' IS NOT NULL THEN PERFORM finnor_os.r8_touch_source(t,'r8:root:'||(s->>'world_root_type')||':'||(s->>'world_root_id'));END IF;
 ELSIF TG_TABLE_NAME='pe_metric_observations' THEN
  PERFORM finnor_os.r8_touch_source(t,'metric-observations:'||(j->>'metric_series_id'));
 ELSE PERFORM finnor_os.r8_touch_source(t,'rights:tenant');END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['work_inputs','canonical_entity_versions','s5_resource_heads','s5_reservations','s5_consumption_states','business_effects',
  'users','authority_states','employee_role_assignments','employee_roles','role_authority_grants','integration_source_scopes'] LOOP
  EXECUTE format('CREATE TRIGGER r8_source_change AFTER INSERT OR UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.r8_source_change()',t);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION finnor_os.r8_touch_source(uuid,text),finnor_os.r8_source_change(),finnor_os.r8_immutable(),finnor_os.r8_request_guard(),finnor_os.r8_grant_guard() FROM PUBLIC;
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_solver_synthesis_v1','HEAVY',ARRAY['HEAVY'],'fixed','tenant','required',1,'Bounded ordinary Rosette/checker/native preparation; no protected method or business execution authority.');
-- A reviewed release owner must configure this real shared capacity policy.
-- The migration does not fabricate memory enforcement, financial funding or a
-- scientific permit. Absence fails closed before any worker child starts.
