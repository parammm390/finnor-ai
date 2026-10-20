-- Additive S2/S3 digital-identification owner records. External truth stays in
-- canonical evidence, business_effects and the original provider-operation ledger.
CREATE TABLE finnor_os.x4_consents(
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,root_id uuid NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=131072),body_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,root_id) REFERENCES finnor_os.pe_deals(tenant_id,id)
);
CREATE UNIQUE INDEX x4_consent_idempotency ON finnor_os.x4_consents(tenant_id,owner_id,(body->>'idempotencyKey'));
CREATE TABLE finnor_os.x4_consent_revocations(
 tenant_id uuid NOT NULL,consent_id uuid NOT NULL,actor_id uuid NOT NULL,reason text NOT NULL,idempotency_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,consent_id),
 FOREIGN KEY(tenant_id,consent_id) REFERENCES finnor_os.x4_consents(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.x4_identifications(
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,root_id uuid NOT NULL,work_id uuid NOT NULL,
 work_input_id uuid NOT NULL,work_input_digest text NOT NULL,consent_id uuid NOT NULL,
 request jsonb NOT NULL,request_digest text NOT NULL,authority_binding jsonb NOT NULL,environment jsonb NOT NULL,dependencies jsonb NOT NULL,target_digests jsonb NOT NULL,
 deadline_at timestamptz NOT NULL,max_experiments integer NOT NULL CHECK(max_experiments BETWEEN 1 AND 64),
 max_observations integer NOT NULL CHECK(max_observations BETWEEN 16 AND 256),
 max_analysis integer NOT NULL CHECK(max_analysis BETWEEN 1 AND 64),max_uses integer NOT NULL CHECK(max_uses BETWEEN 1 AND 16),
 experiment_count integer NOT NULL DEFAULT 0 CHECK(experiment_count BETWEEN 0 AND max_experiments),
 observation_count integer NOT NULL DEFAULT 0 CHECK(observation_count BETWEEN 0 AND max_observations),
 analysis_count integer NOT NULL DEFAULT 0 CHECK(analysis_count BETWEEN 0 AND max_analysis),
 use_count integer NOT NULL DEFAULT 0 CHECK(use_count BETWEEN 0 AND max_uses),
 data_bytes bigint NOT NULL DEFAULT 0 CHECK(data_bytes BETWEEN 0 AND 16777216),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','DISCOVERING','AWAITING_REPLICATION','REPLICATING','DEVELOPMENT_READY','OBSERVATION_ONLY_PARTIAL','UNRESOLVED','WAITING','FAILED','CANCELLED','INVALIDATED')),
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),head_model_id uuid,idempotency_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,owner_id,idempotency_key),UNIQUE(tenant_id,work_id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,root_id) REFERENCES finnor_os.pe_deals(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id),
 FOREIGN KEY(tenant_id,consent_id) REFERENCES finnor_os.x4_consents(tenant_id,id)
);
CREATE TABLE finnor_os.x4_families(
 tenant_id uuid NOT NULL,id uuid NOT NULL,identification_id uuid NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=4194304),
 body_digest text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,identification_id),
 FOREIGN KEY(tenant_id,identification_id) REFERENCES finnor_os.x4_identifications(tenant_id,id)
);
CREATE TABLE finnor_os.x4_instruments(
 tenant_id uuid NOT NULL,id uuid NOT NULL,identification_id uuid NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=262144),
 body_digest text NOT NULL,evidence_source_id uuid NOT NULL,evidence_version_id uuid NOT NULL,evidence_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,identification_id) REFERENCES finnor_os.x4_identifications(tenant_id,id),
 FOREIGN KEY(tenant_id,evidence_source_id) REFERENCES finnor_os.evidence_sources(tenant_id,id),
 FOREIGN KEY(tenant_id,evidence_version_id) REFERENCES finnor_os.evidence_source_versions(tenant_id,id)
);
CREATE TABLE finnor_os.x4_experiments(
 tenant_id uuid NOT NULL,id uuid NOT NULL,identification_id uuid NOT NULL,actor_id uuid NOT NULL,instrument_id uuid NOT NULL,
 phase text NOT NULL CHECK(phase IN('BASELINE','DISCOVERY','FRESH','REPLICATION','DECISION_USE')),
 protocol jsonb NOT NULL CHECK(octet_length(protocol::text)<=1048576),protocol_digest text NOT NULL,
 status text NOT NULL DEFAULT 'REGISTERED' CHECK(status IN('REGISTERED','OBSERVED','UNRESOLVED','FAILED','INVALID')),
 result jsonb,raw jsonb CHECK(octet_length(raw::text)<=262144),evidence_source_id uuid,evidence_version_id uuid,evidence_digest text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,identification_id) REFERENCES finnor_os.x4_identifications(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,instrument_id) REFERENCES finnor_os.x4_instruments(tenant_id,id),
 FOREIGN KEY(tenant_id,evidence_source_id) REFERENCES finnor_os.evidence_sources(tenant_id,id),
 FOREIGN KEY(tenant_id,evidence_version_id) REFERENCES finnor_os.evidence_source_versions(tenant_id,id)
);
CREATE TABLE finnor_os.x4_assignments(
 tenant_id uuid NOT NULL,id uuid NOT NULL,identification_id uuid NOT NULL,actor_id uuid NOT NULL,
 request jsonb NOT NULL,request_digest text NOT NULL,idempotency_key text NOT NULL,
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','RUNNING','COMPLETE','FAILED','CANCELLED')),
 experiment_id uuid,result jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,identification_id,actor_id,idempotency_key),
 FOREIGN KEY(tenant_id,identification_id) REFERENCES finnor_os.x4_identifications(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,experiment_id) REFERENCES finnor_os.x4_experiments(tenant_id,id)
);
CREATE TABLE finnor_os.x4_models(
 tenant_id uuid NOT NULL,id uuid NOT NULL,identification_id uuid NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=4194304),
 body_digest text NOT NULL,dependencies jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,identification_id,id),
 FOREIGN KEY(tenant_id,identification_id) REFERENCES finnor_os.x4_identifications(tenant_id,id)
);
ALTER TABLE finnor_os.x4_identifications ADD FOREIGN KEY(tenant_id,id,head_model_id) REFERENCES finnor_os.x4_models(tenant_id,identification_id,id);
CREATE TABLE finnor_os.x4_uses(
 tenant_id uuid NOT NULL,id uuid NOT NULL,identification_id uuid NOT NULL,model_id uuid NOT NULL,actor_id uuid NOT NULL,
 request jsonb NOT NULL,request_digest text NOT NULL,idempotency_key text NOT NULL,
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','RUNNING','COMPLETE','WAIT','FAILED','CANCELLED')),
 experiment_id uuid,decision_id uuid,result jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,identification_id,actor_id,idempotency_key),
 FOREIGN KEY(tenant_id,identification_id) REFERENCES finnor_os.x4_identifications(tenant_id,id),
 FOREIGN KEY(tenant_id,model_id) REFERENCES finnor_os.x4_models(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,experiment_id) REFERENCES finnor_os.x4_experiments(tenant_id,id),
 FOREIGN KEY(tenant_id,decision_id) REFERENCES finnor_os.pe_decisions(tenant_id,id)
);
CREATE TABLE finnor_os.x4_invalidations(
 tenant_id uuid NOT NULL,id uuid NOT NULL,identification_id uuid NOT NULL,actor_id uuid NOT NULL,
 model_id uuid,reason text NOT NULL,body jsonb NOT NULL,idempotency_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,identification_id,idempotency_key),
 FOREIGN KEY(tenant_id,identification_id) REFERENCES finnor_os.x4_identifications(tenant_id,id),
 FOREIGN KEY(tenant_id,model_id) REFERENCES finnor_os.x4_models(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.s5_identification_charges(
 tenant_id uuid NOT NULL,id uuid NOT NULL,identification_id uuid NOT NULL,actor_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('EXPERIMENT','OBSERVATION','ANALYSIS','USE','RETAINED_BYTES')),amount integer NOT NULL,
 CHECK((kind='RETAINED_BYTES' AND amount BETWEEN 1 AND 16777216) OR (kind<>'RETAINED_BYTES' AND amount=1)),
 idempotency_key text NOT NULL,body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,identification_id,idempotency_key),
 FOREIGN KEY(tenant_id,identification_id) REFERENCES finnor_os.x4_identifications(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.x4_events(
 id bigserial PRIMARY KEY,tenant_id uuid NOT NULL,identification_id uuid NOT NULL,actor_id uuid NOT NULL,
 kind text NOT NULL,idempotency_key text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,identification_id,idempotency_key),
 FOREIGN KEY(tenant_id,identification_id) REFERENCES finnor_os.x4_identifications(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE INDEX x4_work ON finnor_os.x4_identifications(tenant_id,root_id,work_id);
CREATE INDEX x4_experiment_order ON finnor_os.x4_experiments(tenant_id,identification_id,created_at,id);
CREATE INDEX x4_event_history ON finnor_os.x4_events(tenant_id,identification_id,id);
CREATE FUNCTION finnor_os.x4_original_allocation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF to_jsonb(NEW)-ARRAY['experiment_count','observation_count','analysis_count','use_count','data_bytes','status','generation','head_model_id']
 IS DISTINCT FROM to_jsonb(OLD)-ARRAY['experiment_count','observation_count','analysis_count','use_count','data_bytes','status','generation','head_model_id']
 OR NEW.experiment_count<OLD.experiment_count OR NEW.observation_count<OLD.observation_count
 OR NEW.analysis_count<OLD.analysis_count OR NEW.use_count<OLD.use_count OR NEW.data_bytes<OLD.data_bytes OR NEW.generation<OLD.generation
 OR OLD.status IN('CANCELLED','INVALIDATED') AND NEW.status IS DISTINCT FROM OLD.status
 THEN RAISE EXCEPTION 'X4 original Work, inputs, grants and counters cannot reset'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER x4_allocation BEFORE UPDATE ON finnor_os.x4_identifications FOR EACH ROW EXECUTE FUNCTION finnor_os.x4_original_allocation();
CREATE FUNCTION finnor_os.x4_progress_only() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF to_jsonb(NEW)-ARRAY['status','result','raw','evidence_source_id','evidence_version_id','evidence_digest','experiment_id','decision_id']
 IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','result','raw','evidence_source_id','evidence_version_id','evidence_digest','experiment_id','decision_id']
 OR OLD.status IN('OBSERVED','INVALID','FAILED','COMPLETE','WAIT','CANCELLED')
 THEN RAISE EXCEPTION 'X4 immutable assignment/protocol or terminal outcome cannot change'; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['x4_consents','x4_consent_revocations','x4_identifications','x4_families','x4_instruments','x4_experiments','x4_assignments','x4_models','x4_uses','x4_invalidations','s5_identification_charges','x4_events'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY x4_tenant ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id()) WITH CHECK(tenant_id=finnor_os.request_tenant_id())',t);
  EXECUTE format('REVOKE ALL ON finnor_os.%I FROM finnor_app',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  -- PostgreSQL requires UPDATE privilege for SELECT FOR SHARE. The immutable
  -- trigger below still rejects every actual consent update.
  IF t='x4_consents' THEN EXECUTE format('GRANT UPDATE ON finnor_os.%I TO finnor_app',t); END IF;
  IF t IN('x4_identifications','x4_experiments','x4_assignments','x4_uses') THEN
   EXECUTE format('GRANT UPDATE ON finnor_os.%I TO finnor_app',t);
   IF t<>'x4_identifications' THEN EXECUTE format('CREATE TRIGGER x4_progress BEFORE UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.x4_progress_only()',t); END IF;
  ELSE
   EXECUTE format('CREATE TRIGGER x4_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.m3_immutable()',t);
  END IF;
 END LOOP;
END $$;
CREATE FUNCTION finnor_os.x4_retained_storage() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE allocation_id uuid; delta bigint;
BEGIN
 IF TG_TABLE_NAME='x4_identifications' THEN allocation_id:=NEW.id; ELSE allocation_id:=NEW.identification_id; END IF;
 delta:=octet_length(to_jsonb(NEW)::text);
 -- Reserve more than the bounded future growth of the parent's mutable
 -- counters, terminal status and nullable head pointer. Do not undercount it.
 IF TG_TABLE_NAME='x4_identifications' AND TG_OP='INSERT' THEN delta:=delta+512; END IF;
 IF TG_OP='UPDATE' THEN delta:=greatest(0,delta-octet_length(to_jsonb(OLD)::text)); END IF;
 IF delta>0 THEN UPDATE finnor_os.x4_identifications SET data_bytes=data_bytes+delta WHERE tenant_id=NEW.tenant_id AND id=allocation_id; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER x4_storage AFTER INSERT ON finnor_os.x4_identifications FOR EACH ROW EXECUTE FUNCTION finnor_os.x4_retained_storage();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['x4_families','x4_instruments','x4_experiments','x4_assignments','x4_models','x4_uses','x4_invalidations','s5_identification_charges','x4_events'] LOOP
  EXECUTE format('CREATE TRIGGER x4_storage AFTER INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.x4_retained_storage()',t);
 END LOOP;
END $$;
GRANT USAGE,SELECT ON SEQUENCE finnor_os.x4_events_id_seq TO finnor_app;
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('identify_digital_system_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'X4 exact original experiment identity, no blind resubmission, original bounded resources and independent scientific check; development only.');
INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
 VALUES('native:x4-experiment',1,1,0,90,'One shared X4 synthesis/physical experiment/check stack under original Work allocation'),
 ('native:x4-client',2,2,0,30,'Bounded authenticated X4 request concurrency, no execution authority');
