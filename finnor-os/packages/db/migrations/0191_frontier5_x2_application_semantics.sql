-- Additive application-operation domain. These are ordinary native owner
-- preimages/projections, not protected admission or a replacement effect ledger.
CREATE TABLE finnor_os.application_semantics_artifacts (
 tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
 principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 artifact_id text NOT NULL, semantic_owner text NOT NULL,
 version text NOT NULL, content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
 private boolean NOT NULL DEFAULT false,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=2097152),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,artifact_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TRIGGER application_artifact_immutable BEFORE UPDATE OR DELETE
 ON finnor_os.application_semantics_artifacts FOR EACH ROW EXECUTE FUNCTION finnor_os.s6_immutable_origin();

CREATE TABLE finnor_os.application_semantics_sessions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
 principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 work_id uuid NOT NULL, root jsonb NOT NULL,
 work_input_id uuid NOT NULL, work_input_digest text NOT NULL CHECK(work_input_digest ~ '^[a-f0-9]{64}$'),
 parent_id uuid NOT NULL, original_parent_ref jsonb NOT NULL, parent jsonb NOT NULL,
 profile_ids uuid[] NOT NULL CHECK(cardinality(profile_ids) BETWEEN 1 AND 8),
 request jsonb NOT NULL CHECK(octet_length(request::text)<=65536),
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
 rights_revision bigint NOT NULL,
 allocation_ref jsonb NOT NULL, reservation_ref jsonb NOT NULL, root_consumption_ref jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('QUEUED','ACQUIRING','MODEL_READY','PLANNING','EXECUTING',
  'WAITING_OBSERVATION','COMPLETED','UNKNOWN','BLOCKED','CANCELLED','STALE','FAILED')),
 reason text, model_ref jsonb, check_ref jsonb, composition_ref jsonb,
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
 claim_token uuid, claim_fence bigint,
 deadline_at timestamptz NOT NULL, cancel_requested_at timestamptz,
 started_at timestamptz, finished_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,principal_id,id), UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id,parent_id) REFERENCES finnor_os.application_semantics_sessions(tenant_id,principal_id,id)
);
CREATE INDEX application_sessions_work ON finnor_os.application_semantics_sessions(tenant_id,principal_id,work_id,created_at);
CREATE UNIQUE INDEX application_original_work_parent
 ON finnor_os.application_semantics_sessions(tenant_id,principal_id,work_id) WHERE id=parent_id;
CREATE FUNCTION finnor_os.application_session_original_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF OLD.cancel_requested_at IS NOT NULL AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at
  OR NEW.generation<OLD.generation
  OR OLD.status IN ('CANCELLED','FAILED','STALE','BLOCKED') AND NEW.status<>OLD.status
  OR OLD.status='COMPLETED' AND NEW.status NOT IN ('COMPLETED','STALE','CANCELLED')
  OR OLD.model_ref IS NOT NULL AND NEW.model_ref IS DISTINCT FROM OLD.model_ref
  OR OLD.check_ref IS NOT NULL AND NEW.check_ref IS DISTINCT FROM OLD.check_ref
  OR OLD.composition_ref IS NOT NULL AND NEW.composition_ref IS DISTINCT FROM OLD.composition_ref THEN
  RAISE EXCEPTION 'Application cancellation, terminal state or established artifact cannot be replaced';
 END IF;
 IF (NEW.tenant_id,NEW.principal_id,NEW.work_id,NEW.root,NEW.work_input_id,NEW.work_input_digest,
     NEW.parent_id,NEW.original_parent_ref,NEW.parent,NEW.profile_ids,NEW.request,NEW.request_digest,
     NEW.idempotency_key,NEW.rights_revision,NEW.allocation_ref,NEW.reservation_ref,
     NEW.root_consumption_ref,NEW.deadline_at)
  IS DISTINCT FROM
    (OLD.tenant_id,OLD.principal_id,OLD.work_id,OLD.root,OLD.work_input_id,OLD.work_input_digest,
     OLD.parent_id,OLD.original_parent_ref,OLD.parent,OLD.profile_ids,OLD.request,OLD.request_digest,
     OLD.idempotency_key,OLD.rights_revision,OLD.allocation_ref,OLD.reservation_ref,
     OLD.root_consumption_ref,OLD.deadline_at) THEN
  RAISE EXCEPTION 'Original application scope, resource envelope and deadline are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER application_session_original_immutable BEFORE UPDATE
 ON finnor_os.application_semantics_sessions FOR EACH ROW EXECUTE FUNCTION finnor_os.application_session_original_immutable();

CREATE TABLE finnor_os.application_semantics_requests (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 session_id uuid NOT NULL, parent_id uuid NOT NULL, node_id text NOT NULL,
 obligation_id text NOT NULL, request_ref jsonb NOT NULL, binding_ref jsonb NOT NULL,
 wire_digest text NOT NULL CHECK(wire_digest ~ '^[a-f0-9]{64}$'),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=2097152),
 possible_egress boolean NOT NULL DEFAULT false, acknowledged boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'PREPARED' CHECK(status IN ('PREPARED','POSSIBLE_EGRESS','PENDING','VERIFIED','UNKNOWN','DENIED')),
 observation_ref jsonb, response_ref jsonb, reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,session_id,node_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id,session_id) REFERENCES finnor_os.application_semantics_sessions(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,parent_id) REFERENCES finnor_os.application_semantics_sessions(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,obligation_id) REFERENCES finnor_os.s6_obligation_origins(tenant_id,obligation_id)
);
CREATE FUNCTION finnor_os.application_request_fence_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF (NEW.tenant_id,NEW.principal_id,NEW.session_id,NEW.parent_id,NEW.node_id,NEW.obligation_id,
     NEW.request_ref,NEW.binding_ref,NEW.wire_digest,NEW.body)
  IS DISTINCT FROM
    (OLD.tenant_id,OLD.principal_id,OLD.session_id,OLD.parent_id,OLD.node_id,OLD.obligation_id,
     OLD.request_ref,OLD.binding_ref,OLD.wire_digest,OLD.body)
    OR OLD.possible_egress AND NOT NEW.possible_egress
    OR OLD.acknowledged AND NOT NEW.acknowledged THEN
  RAISE EXCEPTION 'Application request identity and possible-egress fence are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER application_request_fence_immutable BEFORE UPDATE
 ON finnor_os.application_semantics_requests FOR EACH ROW EXECUTE FUNCTION finnor_os.application_request_fence_immutable();

CREATE TABLE finnor_os.application_semantics_events (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 session_id uuid NOT NULL, event_id text NOT NULL, kind text NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=2097152),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,event_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id,session_id) REFERENCES finnor_os.application_semantics_sessions(tenant_id,principal_id,id)
);
CREATE TRIGGER application_event_immutable BEFORE UPDATE OR DELETE
 ON finnor_os.application_semantics_events FOR EACH ROW EXECUTE FUNCTION finnor_os.s6_immutable_origin();
CREATE TABLE finnor_os.application_operation_validities (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 model_id text NOT NULL, operation_id text NOT NULL,
 status text NOT NULL CHECK(status IN ('CURRENT','STALE','REVOKED','UNKNOWN')),
 current_binding_ref jsonb NOT NULL, evidence_ref jsonb NOT NULL,
 revision integer NOT NULL CHECK(revision>0), reason text,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,model_id,operation_id),
 FOREIGN KEY(tenant_id,principal_id,model_id) REFERENCES finnor_os.application_semantics_artifacts(tenant_id,principal_id,artifact_id)
);

DO $isolation$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['application_semantics_artifacts','application_semantics_sessions',
   'application_semantics_requests','application_semantics_events','application_operation_validities'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY application_semantics_tenant ON finnor_os.%I '
   'USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid '
   'AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) '
   'WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid '
   'AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',name);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
   EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',name);
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
  GRANT UPDATE ON finnor_os.application_semantics_sessions,finnor_os.application_semantics_requests,
   finnor_os.application_operation_validities TO finnor_app;
 END IF;
END $isolation$;

-- Acquisition/checking/composition also debit the existing original S5 charge table.
ALTER TABLE finnor_os.s5_governed_resource_charges DROP CONSTRAINT s5_governed_resource_charges_phase_check;
ALTER TABLE finnor_os.s5_governed_resource_charges ADD CONSTRAINT s5_governed_resource_charges_phase_check
 CHECK(phase IN ('EXECUTION','RECOVERY','HUMAN','ACQUISITION','CHECKING','COMPOSITION','OBSERVATION','MAINTENANCE'));

-- The disposable file backend is tenant-scoped and runtime-staging-only. It does
-- not supply a production credential or bypass employee/profile authority.
ALTER TABLE finnor_os.auth_profiles DROP CONSTRAINT auth_profiles_credential_contract_check;
ALTER TABLE finnor_os.auth_profiles ADD CONSTRAINT auth_profiles_credential_contract_check CHECK(
 (credential_provider IS NULL AND credential_ref IS NULL AND credential_version IS NULL)
 OR (credential_provider='aws-secrets-manager' AND credential_ref IS NOT NULL
  AND btrim(credential_ref)<>'' AND position(tenant_id::text IN credential_ref)>0
  AND (credential_version IS NULL OR btrim(credential_version)<>''))
 OR (credential_provider='os-keychain' AND credential_ref LIKE 'finnor/tenants/'||tenant_id::text||'/%' AND credential_version IS NULL)
 OR (credential_provider='disposable-private-file' AND auth_method='application_headers'
  AND credential_ref ~ ('^finnor/tenants/'||tenant_id::text||'/x2/[A-Za-z0-9_-]{1,128}$') AND credential_version IS NULL)
 OR (credential_provider='legacy-env' AND credential_ref ~ '^legacy-env:(quickbooks|vapi|stripe|docusign|ghl|gmail|resend|meta_ads|google_ads)$'
  AND credential_version IS NULL)
 OR (credential_provider='aws-iam-federated' AND credential_ref IS NULL AND credential_version IS NULL)
);
ALTER TABLE finnor_os.auth_profiles DROP CONSTRAINT IF EXISTS auth_profiles_auth_method_check;
ALTER TABLE finnor_os.auth_profiles ADD CONSTRAINT auth_profiles_auth_method_check
 CHECK(auth_method IN ('managed_secret','oauth2','browser_profile','workload_identity','application_headers'));
ALTER TABLE finnor_os.auth_profiles ADD CONSTRAINT auth_profiles_application_header_shape_check
 CHECK(auth_method<>'application_headers' OR credential_provider IS NOT NULL AND credential_provider IN ('aws-secrets-manager','disposable-private-file'));

INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,
 tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_application_semantics_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'X2 typed application semantics; original S5/S6 identity, exact before-wire fence and read-only recovery');
INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
 VALUES('native:x2',1,1,0,120,'X2 serialized local development delivery; engineering concurrency, not S5 funding or aggregate memory qualification');
