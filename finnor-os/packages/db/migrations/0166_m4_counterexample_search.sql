-- Local unique M4 candidate. Final cross-branch serialized ordinal remains a handoff obligation.
-- Bounded development evidence. No S-owner funding, effect authority or admission.
ALTER TABLE finnor_os.data_retention_holds
 DROP CONSTRAINT data_retention_holds_resource_type_check,
 ADD CONSTRAINT data_retention_holds_resource_type_check
 CHECK(resource_type IN('call','message','job','work','m4_search'));
ALTER TABLE finnor_os.tenant_retention_policies
 DROP CONSTRAINT tenant_retention_policies_data_class_check,
 ADD CONSTRAINT tenant_retention_policies_data_class_check
 CHECK(data_class IN('messages','job_payloads','computer_artifact_content','model_records','m4_evidence'));
CREATE TABLE finnor_os.m4_searches(
 id uuid NOT NULL,tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),principal_id uuid NOT NULL,
 work_id uuid NOT NULL,work_input_id uuid NOT NULL,work_input_digest text NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key)<=200),request_digest text NOT NULL,
 frozen_digest text NOT NULL,report_digest text,parent_search_id uuid,
 limits jsonb NOT NULL CHECK(octet_length(limits::text)<=2048),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','RUNNING','COMPLETED','CANCELLED','FAILED','EXPIRED','STALE')),
 job_id uuid,active_claim_token uuid,active_claim_fence bigint,trials integer NOT NULL DEFAULT 0 CHECK(trials BETWEEN 0 AND 512),
 retained_bytes bigint NOT NULL DEFAULT 0 CHECK(retained_bytes BETWEEN 0 AND 8388608),
 deadline_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id),UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id,parent_search_id) REFERENCES finnor_os.m4_searches(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.m4_records(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,
 digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),kind text NOT NULL CHECK(length(kind)<=64),
 plaintext_bytes integer NOT NULL CHECK(plaintext_bytes BETWEEN 0 AND 4194304),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,search_id,digest),
 FOREIGN KEY(tenant_id,principal_id,search_id) REFERENCES finnor_os.m4_searches(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.m4_payloads(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,digest text NOT NULL,
 key_id text NOT NULL CHECK(length(key_id)<=80),nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
 tag bytea NOT NULL CHECK(octet_length(tag)=16),ciphertext bytea NOT NULL CHECK(octet_length(ciphertext)<=4194304),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,principal_id,search_id,digest),
 FOREIGN KEY(tenant_id,principal_id,search_id,digest) REFERENCES finnor_os.m4_records(tenant_id,principal_id,search_id,digest)
);
CREATE INDEX m4_payload_retention_idx ON finnor_os.m4_payloads(tenant_id,principal_id,expires_at);
CREATE TABLE finnor_os.m4_events(
 id uuid NOT NULL DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,
 attempt_id uuid,kind text NOT NULL CHECK(length(kind)<=64),record_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,search_id,record_digest) REFERENCES finnor_os.m4_records(tenant_id,principal_id,search_id,digest)
);
CREATE INDEX m4_events_search_idx ON finnor_os.m4_events(tenant_id,principal_id,search_id,created_at,id);
CREATE TABLE finnor_os.m4_allocations(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,root_search_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('CELL','REDUCTION','WITNESS')),
 allocation_key text NOT NULL CHECK(allocation_key~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,root_search_id,kind,allocation_key),
 FOREIGN KEY(tenant_id,principal_id,root_search_id) REFERENCES finnor_os.m4_searches(tenant_id,principal_id,id)
);
CREATE FUNCTION finnor_os.m4_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN RAISE EXCEPTION 'M4 immutable evidence: append a new record or linked search'; END $$;
CREATE FUNCTION finnor_os.m4_search_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['status','job_id','report_digest','active_claim_token','active_claim_fence','trials','retained_bytes','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','job_id','report_digest','active_claim_token','active_claim_fence','trials','retained_bytes','updated_at']) OR
    NEW.trials<OLD.trials OR NEW.retained_bytes<OLD.retained_bytes OR
    (OLD.report_digest IS NOT NULL AND NEW.report_digest IS DISTINCT FROM OLD.report_digest) THEN
  RAISE EXCEPTION 'M4 immutable search identity or monotone accounting changed';
 END IF;
 IF OLD.status IN('CANCELLED','FAILED','EXPIRED','STALE') AND NEW.status<>OLD.status OR
    OLD.status='COMPLETED' AND NEW.status NOT IN('COMPLETED','CANCELLED','STALE') OR
    OLD.status='RUNNING' AND NEW.status='QUEUED' THEN
  RAISE EXCEPTION 'M4 terminal search cannot be resurrected';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER m4_search_transition BEFORE UPDATE ON finnor_os.m4_searches FOR EACH ROW EXECUTE FUNCTION finnor_os.m4_search_transition();
CREATE FUNCTION finnor_os.m4_retention_delete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF OLD.expires_at>clock_timestamp() OR EXISTS(
  SELECT 1 FROM finnor_os.data_retention_holds h WHERE h.tenant_id=OLD.tenant_id AND h.released_at IS NULL AND
   ((h.resource_type='m4_search' AND h.resource_id=OLD.search_id) OR
    (h.resource_type='work' AND h.resource_id=(SELECT work_id FROM finnor_os.m4_searches WHERE tenant_id=OLD.tenant_id AND principal_id=OLD.principal_id AND id=OLD.search_id)))) OR
    EXISTS(SELECT 1 FROM finnor_os.tenant_retention_policies p WHERE p.tenant_id=OLD.tenant_id AND p.data_class='m4_evidence' AND p.legal_hold) THEN
  RAISE EXCEPTION 'M4 retention deadline or legal hold prohibits payload deletion';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER m4_payload_immutable BEFORE UPDATE ON finnor_os.m4_payloads FOR EACH ROW EXECUTE FUNCTION finnor_os.m4_immutable();
CREATE TRIGGER m4_payload_retention BEFORE DELETE ON finnor_os.m4_payloads FOR EACH ROW EXECUTE FUNCTION finnor_os.m4_retention_delete();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['m4_searches','m4_records','m4_payloads','m4_events','m4_allocations'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY m4_private_principal ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  IF t IN('m4_records','m4_events','m4_allocations') THEN
   EXECUTE format('CREATE TRIGGER m4_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.m4_immutable()',t);
  END IF;
 END LOOP;
 GRANT UPDATE ON finnor_os.m4_searches TO finnor_app;
 GRANT DELETE ON finnor_os.m4_payloads TO finnor_app;
END $$;
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_counterexample_search_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,'Frozen bounded native challenge for accepted Work. No live effects or protected admission.');
-- Observe current owners, never mutate their semantics. Lock the same P4 revision
-- rows at publication so a concurrent source/resource/plan commit cannot win the cut.
CREATE FUNCTION finnor_os.m4_owner_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE j jsonb; t uuid; k text; BEGIN
 j:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;t:=(j->>'tenant_id')::uuid;
 IF t IS NULL THEN RETURN NULL; END IF;
 k:=CASE WHEN TG_TABLE_NAME='work_plan_revisions' THEN 'm4-work-plan:'||(j->>'work_id')
         WHEN TG_TABLE_NAME IN('s5_resources','s5_reservations','business_effects') THEN 'm4-current-resources-and-effects'
         ELSE 'm4-current-source-membership' END;
 PERFORM finnor_os.p4_touch_source(t,k);RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION finnor_os.m4_owner_change() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['canonical_entity_versions','documents','document_versions','document_version_heads','artifact_bindings','evidence_source_versions','s5_resources','s5_reservations','business_effects','work_plan_revisions'] LOOP
  EXECUTE format('CREATE TRIGGER m4_owner_change AFTER INSERT OR UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.m4_owner_change()',t);
 END LOOP;
END $$;
-- Capacity and encryption key are explicit operator/disposable-fixture configuration.
