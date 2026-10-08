-- Ordinary producer persistence; no protected admission or S-owner receipt.
CREATE TABLE finnor_os.p4_source_revisions(
 tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),key text NOT NULL CHECK(length(key)<=512),revision bigint NOT NULL DEFAULT 0,
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,key)
);
CREATE TABLE finnor_os.p4_acquisition_attempts(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.p4_runtime_manifests(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,digest text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,principal_id,digest),FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.p4_queries(
 id uuid NOT NULL DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),principal_id uuid NOT NULL,
 root jsonb NOT NULL,work_id uuid NOT NULL,work_input_id uuid NOT NULL,work_input_digest text NOT NULL,
 idempotency_key text NOT NULL,request_digest text NOT NULL,request jsonb NOT NULL CHECK(octet_length(request::text)<=65536),
 generation integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','RUNNING','TESTED','PARTIAL','FAILED','INVALIDATED','CANCELLED')),
 derivation_id uuid,active_claim_token uuid,active_claim_fence bigint,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id),UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id)
);
CREATE TABLE finnor_os.p4_handles(
 id uuid NOT NULL,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=262144),digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.p4_plans(
 id uuid NOT NULL DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,principal_id uuid NOT NULL,query_id uuid NOT NULL,generation integer NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),digest text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id),UNIQUE(tenant_id,principal_id,query_id,generation),
 FOREIGN KEY(tenant_id,principal_id,query_id) REFERENCES finnor_os.p4_queries(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.p4_derivations(
 id uuid NOT NULL,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,query_id uuid NOT NULL,generation integer NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=8388608),digest text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id),UNIQUE(tenant_id,principal_id,query_id,generation),
 FOREIGN KEY(tenant_id,principal_id,query_id) REFERENCES finnor_os.p4_queries(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.p4_dependencies(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,derivation_id uuid NOT NULL,key text NOT NULL,revision bigint NOT NULL,node_ids text[] NOT NULL,digest text,
 PRIMARY KEY(tenant_id,principal_id,derivation_id,key),FOREIGN KEY(tenant_id,principal_id,derivation_id) REFERENCES finnor_os.p4_derivations(tenant_id,principal_id,id)
);
CREATE INDEX p4_dependencies_change_idx ON finnor_os.p4_dependencies(tenant_id,key,derivation_id);
CREATE TABLE finnor_os.p4_nodes(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,derivation_id uuid NOT NULL,node_id text NOT NULL,cache_key text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=8388608),digest text NOT NULL,
 PRIMARY KEY(tenant_id,principal_id,derivation_id,node_id),FOREIGN KEY(tenant_id,principal_id,derivation_id) REFERENCES finnor_os.p4_derivations(tenant_id,principal_id,id)
);
CREATE INDEX p4_node_reuse_idx ON finnor_os.p4_nodes(tenant_id,principal_id,cache_key);
CREATE TABLE finnor_os.p4_witnesses(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,derivation_id uuid NOT NULL,witness_id text NOT NULL,body jsonb NOT NULL,digest text NOT NULL,
 PRIMARY KEY(tenant_id,principal_id,derivation_id,witness_id),FOREIGN KEY(tenant_id,principal_id,derivation_id) REFERENCES finnor_os.p4_derivations(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.p4_checks(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,derivation_id uuid NOT NULL,check_id text NOT NULL,body jsonb NOT NULL,
 PRIMARY KEY(tenant_id,principal_id,derivation_id,check_id),FOREIGN KEY(tenant_id,principal_id,derivation_id) REFERENCES finnor_os.p4_derivations(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.p4_attempt_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,principal_id uuid NOT NULL,query_id uuid NOT NULL,attempt_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('STARTED','FINISHED','FAILED','CANCELLED','FENCED','KEPT_VALIDITY','INVALIDATED')),body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),FOREIGN KEY(tenant_id,principal_id,query_id) REFERENCES finnor_os.p4_queries(tenant_id,principal_id,id)
);
CREATE INDEX p4_attempt_query_idx ON finnor_os.p4_attempt_events(tenant_id,principal_id,query_id,created_at);
CREATE FUNCTION finnor_os.p4_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN RAISE EXCEPTION 'P4 evidence records are immutable; append a new linked generation'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['p4_acquisition_attempts','p4_runtime_manifests','p4_queries','p4_handles','p4_plans','p4_derivations','p4_dependencies','p4_nodes','p4_witnesses','p4_checks','p4_attempt_events'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY p4_principal_isolation ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  IF t<>'p4_queries' THEN EXECUTE format('CREATE TRIGGER p4_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.p4_immutable()',t); END IF;
 END LOOP;
 GRANT UPDATE ON finnor_os.p4_queries TO finnor_app;
 ALTER TABLE finnor_os.p4_source_revisions ENABLE ROW LEVEL SECURITY;
 ALTER TABLE finnor_os.p4_source_revisions FORCE ROW LEVEL SECURITY;
 CREATE POLICY p4_revision_tenant ON finnor_os.p4_source_revisions USING(tenant_id=finnor_os.request_tenant_id()) WITH CHECK(tenant_id=finnor_os.request_tenant_id());
 GRANT SELECT,INSERT,UPDATE ON finnor_os.p4_source_revisions TO finnor_app;
END $$;

-- This trigger executes as a narrowly scoped table owner so a source writer can
-- invalidate dependent principals without reading their private evidence. Every
-- dependency mutation and publication lock the same revision row. A stale
-- worker therefore cannot win a source/rights race by comparing timestamps.
CREATE FUNCTION finnor_os.p4_touch_source(t uuid,k text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE d uuid; BEGIN
 INSERT INTO finnor_os.p4_source_revisions(tenant_id,key,revision) VALUES(t,k,1)
 ON CONFLICT(tenant_id,key) DO UPDATE SET revision=p4_source_revisions.revision+1,changed_at=clock_timestamp();
 FOR d IN UPDATE finnor_os.p4_queries q SET status='INVALIDATED',updated_at=clock_timestamp()
  WHERE q.tenant_id=t AND q.status IN('TESTED','PARTIAL') AND EXISTS(
   SELECT 1 FROM finnor_os.p4_dependencies dep WHERE dep.tenant_id=t AND dep.principal_id=q.principal_id AND dep.derivation_id=q.derivation_id AND dep.key=k)
  RETURNING derivation_id
 LOOP PERFORM finnor_os.p4_touch_source(t,'derivation:'||d::text); END LOOP;
END $$;
REVOKE ALL ON FUNCTION finnor_os.p4_touch_source(uuid,text) FROM PUBLIC;
CREATE FUNCTION finnor_os.p4_source_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE j jsonb;t uuid;k text;s jsonb;series_id uuid; BEGIN
 j:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;t:=(j->>'tenant_id')::uuid;
 IF t IS NULL THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='canonical_entity_versions' THEN
  PERFORM finnor_os.p4_touch_source(t,'canonical:'||(j->>'entity_type')||':'||(j->>'entity_id'));
  s:=j->'snapshot';
  IF j->>'entity_type'='pe_metric_series' THEN
   k:='metric-series:'||coalesce(s->>'subject_type','')||':'||coalesce(s->>'subject_id','')||':'||coalesce(s->>'metric_key','');
   PERFORM finnor_os.p4_touch_source(t,k);
   PERFORM finnor_os.p4_touch_source(t,'metric-series:'||coalesce(s->>'subject_type','')||':'||coalesce(s->>'subject_id','')||':*');
  ELSIF j->>'entity_type'='pe_metric_observation' THEN
   PERFORM finnor_os.p4_touch_source(t,'metric-observations:'||(s->>'metric_series_id'));
  END IF;
 ELSIF TG_TABLE_NAME='pe_metric_observations' THEN
  PERFORM finnor_os.p4_touch_source(t,'canonical:pe_metric_observation:'||(j->>'id'));
  PERFORM finnor_os.p4_touch_source(t,'metric-observations:'||(j->>'metric_series_id'));
 ELSIF TG_TABLE_NAME='pe_metric_series' THEN
  PERFORM finnor_os.p4_touch_source(t,'canonical:pe_metric_series:'||(j->>'id'));
  PERFORM finnor_os.p4_touch_source(t,'metric-series:'||(j->>'subject_type')||':'||(j->>'subject_id')||':'||(j->>'metric_key'));
  PERFORM finnor_os.p4_touch_source(t,'metric-series:'||(j->>'subject_type')||':'||(j->>'subject_id')||':*');
 ELSIF TG_TABLE_NAME IN('document_versions','document_version_heads','documents') THEN
  PERFORM finnor_os.p4_touch_source(t,'document:'||coalesce(j->>'document_id',j->>'id'));
 ELSIF TG_TABLE_NAME='artifact_bindings' THEN
  PERFORM finnor_os.p4_touch_source(t,'document-binding:'||(j->>'version_id'));
 ELSIF TG_TABLE_NAME='evidence_source_versions' THEN
  PERFORM finnor_os.p4_touch_source(t,'evidence:'||(j->>'source_id'));
 ELSIF TG_TABLE_NAME='work_inputs' THEN
  PERFORM finnor_os.p4_touch_source(t,'work-inputs:'||(j->>'work_id'));
 ELSE PERFORM finnor_os.p4_touch_source(t,'rights:tenant'); END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION finnor_os.p4_source_change() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['canonical_entity_versions','pe_metric_observations','pe_metric_series','documents','document_versions','document_version_heads','artifact_bindings','evidence_source_versions','work_inputs','authority_states','users','employee_role_assignments','employee_roles','role_authority_grants','integration_source_scopes'] LOOP
  EXECUTE format('CREATE TRIGGER p4_source_change AFTER INSERT OR UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.p4_source_change()',t);
 END LOOP;
END $$;
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_evidence_derivation_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,'Bounded native evidence computation for accepted Work; no protected admission.');
-- Capacity must be explicitly configured by the operator or disposable fixture.
-- No production funding or resource capacity is invented by this migration.
