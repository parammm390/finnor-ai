-- Delivery05 native producer. 0156/P3 and0157/P1 remain separate candidate
-- migrations. This additive id must be serialized again at their final join.
-- Core owns these relationships. S1 needs exact committed relationship history
-- to bind the actual Work/P4 intake, not a waiver for a mutable current row.
LOCK TABLE finnor_os.work_entity_links IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO finnor_os.canonical_truth_registry
 (entity_type,vertical_key,source_table,writable_owner,mutation_boundary,work_attachable)
 VALUES('work_entity_link',NULL,'work_entity_links','@finnor/db','Core Work attachment and relationship mutation',false);
DO $work_link_baseline$
DECLARE baseline_at timestamptz:=clock_timestamp(); BEGIN
 INSERT INTO finnor_os.canonical_history_coverage
  (entity_type,source_table,vertical_key,coverage_started_at,baseline_completed_at)
  VALUES('work_entity_link','work_entity_links','private_equity',baseline_at,baseline_at);
 INSERT INTO finnor_os.canonical_entity_versions
  (tenant_id,entity_type,entity_id,entity_version,snapshot,snapshot_hash,recorded_at,actor,origin)
  SELECT tenant_id,'work_entity_link',id,1,to_jsonb(l)||jsonb_build_object('history_deleted',false),
   encode(public.digest(convert_to((to_jsonb(l)||jsonb_build_object('history_deleted',false))::text,'UTF8'),'sha256'),'hex'),
   baseline_at,'migration:Core Work relationship baseline','baseline'
  FROM finnor_os.work_entity_links l;
END $work_link_baseline$;
CREATE FUNCTION finnor_os.append_core_work_link_version() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE body jsonb;prior record; BEGIN
 IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id)
  THEN RAISE EXCEPTION 'Core Work relationship identity is immutable'; END IF;
 body:=(CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END)
  ||jsonb_build_object('history_deleted',TG_OP='DELETE');
 PERFORM pg_advisory_xact_lock(hashtextextended((body->>'tenant_id')||':work_entity_link:'||(body->>'id'),5110));
 SELECT id,entity_version INTO prior FROM finnor_os.canonical_entity_versions
  WHERE tenant_id=(body->>'tenant_id')::uuid AND entity_type='work_entity_link' AND entity_id=(body->>'id')::uuid
  ORDER BY entity_version DESC LIMIT 1;
 INSERT INTO finnor_os.canonical_entity_versions
  (tenant_id,entity_type,entity_id,entity_version,snapshot,snapshot_hash,recorded_at,actor,origin,previous_version_id)
  VALUES((body->>'tenant_id')::uuid,'work_entity_link',(body->>'id')::uuid,coalesce(prior.entity_version,0)+1,
   body,encode(public.digest(convert_to(body::text,'UTF8'),'sha256'),'hex'),clock_timestamp(),
   nullif(current_setting('app.user_id',true),''),'mutation',prior.id);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION finnor_os.append_core_work_link_version() FROM PUBLIC;
CREATE TRIGGER core_work_link_history AFTER INSERT OR UPDATE OR DELETE ON finnor_os.work_entity_links
 FOR EACH ROW EXECUTE FUNCTION finnor_os.append_core_work_link_version();

CREATE TABLE finnor_os.m3_queries(
 id uuid NOT NULL,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,work_input_id uuid NOT NULL,
 work_input_digest text NOT NULL,plan_id uuid NOT NULL,plan_digest text NOT NULL,
 idempotency_key text NOT NULL,request_digest text NOT NULL,request jsonb NOT NULL CHECK(octet_length(request::text)<=65536),
 acceptance jsonb NOT NULL CHECK(octet_length(acceptance::text)<=8388608),
 parent_query_id uuid,generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','RUNNING','TESTED','PARTIAL','FAILED','INVALIDATED','CANCELLED')),
 result_digest text,active_claim_token uuid,active_claim_fence bigint,first_started_at timestamptz,deadline_at timestamptz,
 attempted integer NOT NULL DEFAULT 0,generated integer NOT NULL DEFAULT 0,refinement_steps integer NOT NULL DEFAULT 0,
 failure jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id),UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id),
 FOREIGN KEY(tenant_id,plan_id) REFERENCES finnor_os.work_plan_revisions(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id,parent_query_id) REFERENCES finnor_os.m3_queries(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.m3_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,principal_id uuid NOT NULL,query_id uuid NOT NULL,attempt_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('STARTED','CANDIDATE','MODULE_PREPARED','CHECK','FINISHED','FAILED','FENCED','CANCELLED','INVALIDATED','RESUMED','SELECTION')),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=8388608),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,principal_id,query_id) REFERENCES finnor_os.m3_queries(tenant_id,principal_id,id)
);
CREATE INDEX m3_events_query_idx ON finnor_os.m3_events(tenant_id,principal_id,query_id,created_at,id);
CREATE INDEX m3_queries_work_idx ON finnor_os.m3_queries(tenant_id,principal_id,work_id,created_at DESC,id DESC);
CREATE TABLE finnor_os.m3_publications(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,query_id uuid NOT NULL,generation integer NOT NULL,
 result_digest text NOT NULL CHECK(result_digest~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,query_id,generation),
 FOREIGN KEY(tenant_id,principal_id,query_id) REFERENCES finnor_os.m3_queries(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.m3_dependencies(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,query_id uuid NOT NULL,key text NOT NULL,revision bigint NOT NULL,
 PRIMARY KEY(tenant_id,principal_id,query_id,key),
 FOREIGN KEY(tenant_id,principal_id,query_id) REFERENCES finnor_os.m3_queries(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.m3_branch_reviews(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,query_id uuid NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 request_digest text NOT NULL CHECK(request_digest~'^[a-f0-9]{64}$'),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=8388608),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id,query_id) REFERENCES finnor_os.m3_queries(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.s5_candidate_problems(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,content_digest text NOT NULL CHECK(content_digest~'^[a-f0-9]{64}$'),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=8388608),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,content_digest),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE FUNCTION finnor_os.m3_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN RAISE EXCEPTION 'M3 history is immutable; append an exact linked child'; END $$;
CREATE FUNCTION finnor_os.m3_query_update() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF to_jsonb(NEW)-ARRAY['status','generation','result_digest','active_claim_token','active_claim_fence','first_started_at','deadline_at','attempted','generated','refinement_steps','failure','updated_at']
  IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','generation','result_digest','active_claim_token','active_claim_fence','first_started_at','deadline_at','attempted','generated','refinement_steps','failure','updated_at']
  THEN RAISE EXCEPTION 'M3 accepted identity and inputs are immutable'; END IF;
 IF OLD.first_started_at IS NOT NULL AND (NEW.first_started_at IS DISTINCT FROM OLD.first_started_at OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at)
  THEN RAISE EXCEPTION 'M3 cannot renew an elapsed episode grant'; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['m3_queries','m3_events','m3_publications','m3_dependencies','m3_branch_reviews','s5_candidate_problems'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY m3_principal_isolation ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  -- Earlier default privileges include mutation/TRUNCATE. Narrow them before
  -- granting this producer's actual immutable-history access.
  EXECUTE format('REVOKE ALL ON finnor_os.%I FROM finnor_app',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  IF t<>'m3_queries' THEN EXECUTE format('CREATE TRIGGER m3_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.m3_immutable()',t); END IF;
 END LOOP;
 GRANT UPDATE ON finnor_os.m3_queries TO finnor_app;
 CREATE TRIGGER m3_query_update BEFORE UPDATE ON finnor_os.m3_queries FOR EACH ROW EXECUTE FUNCTION finnor_os.m3_query_update();
END $$;
-- Reuse the predecessor's shared source revision lock. Native membership,
-- complete S5 commitments and Plan/S6 changes must fence M3 at publication.
CREATE FUNCTION finnor_os.m3_touch_source(t uuid,k text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 PERFORM finnor_os.p4_touch_source(t,k);
 UPDATE finnor_os.m3_queries q SET status='INVALIDATED',generation=generation+1,updated_at=clock_timestamp(),
  failure=jsonb_build_object('code','DEPENDENCY_REVISED','requirement',k)
  WHERE q.tenant_id=t AND q.status IN('QUEUED','RUNNING','TESTED','PARTIAL') AND EXISTS(
   SELECT 1 FROM finnor_os.m3_dependencies d WHERE d.tenant_id=t AND d.principal_id=q.principal_id AND d.query_id=q.id AND d.key=k);
END $$;
REVOKE ALL ON FUNCTION finnor_os.m3_touch_source(uuid,text) FROM PUBLIC;
CREATE FUNCTION finnor_os.m3_source_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE j jsonb;t uuid;s jsonb;prior_snapshot jsonb;root_type text;root_id text; BEGIN
 j:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;t:=(j->>'tenant_id')::uuid;
 IF t IS NULL THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='canonical_entity_versions' THEN
  s:=j->'snapshot';root_type:=s->>'world_root_type';root_id:=s->>'world_root_id';
  IF root_type IS NOT NULL AND root_id IS NOT NULL THEN PERFORM finnor_os.m3_touch_source(t,'m3:root:'||root_type||':'||root_id); END IF;
  IF j->>'entity_type'='work_entity_link' THEN
   PERFORM finnor_os.m3_touch_source(t,'m3:root:'||(s->>'entity_type')||':'||(s->>'entity_id'));
   SELECT snapshot INTO prior_snapshot FROM finnor_os.canonical_entity_versions WHERE id=(j->>'previous_version_id')::uuid;
   IF prior_snapshot IS NOT NULL AND (prior_snapshot->>'entity_type',prior_snapshot->>'entity_id')
    IS DISTINCT FROM (s->>'entity_type',s->>'entity_id') THEN
    PERFORM finnor_os.m3_touch_source(t,'m3:root:'||(prior_snapshot->>'entity_type')||':'||(prior_snapshot->>'entity_id'));
   END IF;
  END IF;
  PERFORM finnor_os.m3_touch_source(t,'canonical:'||(j->>'entity_type')||':'||(j->>'entity_id'));
 ELSIF TG_TABLE_NAME IN('s5_resource_heads','s5_reservations','s5_consumption_states') THEN
  PERFORM finnor_os.m3_touch_source(t,'m3:s5-complete');
 ELSIF TG_TABLE_NAME='business_effects' THEN PERFORM finnor_os.m3_touch_source(t,'m3:s6-effects');
 ELSIF TG_TABLE_NAME='work_plan_revisions' THEN PERFORM finnor_os.m3_touch_source(t,'m3:plan:'||(j->>'work_id'));
 ELSIF TG_TABLE_NAME='work_inputs' THEN PERFORM finnor_os.m3_touch_source(t,'work-inputs:'||(j->>'work_id'));
 ELSIF TG_TABLE_NAME='pe_metric_observations' THEN PERFORM finnor_os.m3_touch_source(t,'metric-observations:'||(j->>'metric_series_id'));
 ELSIF TG_TABLE_NAME='evidence_source_versions' THEN PERFORM finnor_os.m3_touch_source(t,'evidence:'||(j->>'source_id'));
 ELSE PERFORM finnor_os.m3_touch_source(t,'rights:tenant');
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION finnor_os.m3_source_change() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['canonical_entity_versions','s5_resource_heads','s5_reservations','s5_consumption_states','business_effects','work_plan_revisions','work_inputs','pe_metric_observations','evidence_source_versions','authority_states','users','employee_role_assignments','employee_roles','role_authority_grants','integration_source_scopes'] LOOP
  EXECUTE format('CREATE TRIGGER m3_source_change AFTER INSERT OR UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.m3_source_change()',t);
 END LOOP;
END $$;
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_capital_program_v2','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,'Bounded nonconsequential economic proposals under exact Work/Plan; no allocation or admission granted.');
-- No financial funding, provider capacity or physical quota is fabricated.
