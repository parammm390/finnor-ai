-- P2: Microsoft 365 live nervous system control plane and provider observations.
--
-- This migration deliberately reuses tenant_integrations, auth_profiles,
-- integration_sync_checkpoints, external_refs/external_ref_observations,
-- Evidence, Document, reconciliation_cases, BusinessEvents, Work waits, and jobs.
-- It adds no Microsoft-specific business owner or second truth/event/queue system.

-- ---------------------------------------------------------------------------
-- Secretless AWS IAM -> Entra workload identity and administrative consent proof.
-- ---------------------------------------------------------------------------
ALTER TABLE finnor_os.auth_profiles DROP CONSTRAINT IF EXISTS auth_profiles_auth_method_check;
ALTER TABLE finnor_os.auth_profiles ADD CONSTRAINT auth_profiles_auth_method_check
  CHECK (auth_method IN ('managed_secret','oauth2','browser_profile','workload_identity'));

ALTER TABLE finnor_os.auth_profiles DROP CONSTRAINT IF EXISTS auth_profiles_credential_contract_check;
ALTER TABLE finnor_os.auth_profiles ADD CONSTRAINT auth_profiles_credential_contract_check CHECK (
  (credential_provider IS NULL AND credential_ref IS NULL AND credential_version IS NULL)
  OR (credential_provider='aws-secrets-manager' AND credential_ref IS NOT NULL
      AND btrim(credential_ref)<>'' AND position(tenant_id::text IN credential_ref)>0
      AND (credential_version IS NULL OR btrim(credential_version)<>''))
  OR (credential_provider='aws-iam-federated' AND credential_ref IS NULL AND credential_version IS NULL)
  OR (credential_provider='os-keychain' AND credential_ref IS NOT NULL
      AND credential_ref LIKE 'finnor/tenants/'||tenant_id::text||'/%'
      AND credential_version IS NULL)
  OR (credential_provider='legacy-env' AND credential_ref ~ '^legacy-env:(quickbooks|vapi|stripe|docusign|ghl|gmail|resend|meta_ads|google_ads)$'
      AND credential_version IS NULL)
);
ALTER TABLE finnor_os.auth_profiles DROP CONSTRAINT IF EXISTS auth_profiles_workload_identity_shape_check;
ALTER TABLE finnor_os.auth_profiles ADD CONSTRAINT auth_profiles_workload_identity_shape_check CHECK (
  (auth_method='workload_identity' AND credential_provider='aws-iam-federated'
    AND credential_ref IS NULL AND credential_version IS NULL)
  OR (auth_method<>'workload_identity' AND credential_provider IS DISTINCT FROM 'aws-iam-federated')
);

ALTER TABLE finnor_os.tenant_integrations DROP CONSTRAINT IF EXISTS tenant_integrations_credential_contract_check;
ALTER TABLE finnor_os.tenant_integrations ADD CONSTRAINT tenant_integrations_credential_contract_check CHECK (
  (credential_provider IS NULL AND credential_ref IS NULL
    AND credential_version IS NULL AND credential_metadata='{}'::jsonb)
  OR (credential_provider='aws-secrets-manager' AND credential_ref IS NOT NULL
    AND btrim(credential_ref)<>'' AND (credential_version IS NULL OR btrim(credential_version)<>''))
  OR (credential_provider='aws-iam-federated' AND credential_ref IS NULL AND credential_version IS NULL)
  OR (credential_provider='legacy-env'
    AND credential_ref ~ '^legacy-env:(quickbooks|vapi|stripe|docusign|ghl|gmail|resend|meta_ads|google_ads)$'
    AND credential_version IS NULL)
);

ALTER TABLE finnor_os.connection_events DROP CONSTRAINT IF EXISTS connection_events_event_type_check;
ALTER TABLE finnor_os.connection_events ADD CONSTRAINT connection_events_event_type_check CHECK (event_type IN (
  'connect_started','connect_failed','consent_requested','consent_returned','connected',
  'refreshed','verified','permission_verified','degraded','reauth_required','revoked',
  'disabled','reconnected','provider_unavailable'
));

CREATE TABLE finnor_os.application_consent_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  auth_profile_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider=lower(provider) AND provider ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  state_hash text NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  expected_directory_tenant_id text NOT NULL CHECK (expected_directory_tenant_id ~ '^[0-9a-fA-F-]{36}$'),
  returned_directory_tenant_id text CHECK (returned_directory_tenant_id IS NULL OR returned_directory_tenant_id ~ '^[0-9a-fA-F-]{36}$'),
  redirect_uri text NOT NULL CHECK (redirect_uri ~ '^https?://'),
  requested_permissions text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','returned','verified','failed','expired')),
  permission_verification jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT application_consent_requests_profile_tenant_fkey
    FOREIGN KEY (tenant_id,auth_profile_id) REFERENCES finnor_os.auth_profiles(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT application_consent_requests_actor_tenant_fkey
    FOREIGN KEY (tenant_id,actor_id) REFERENCES finnor_os.users(tenant_id,id),
  CONSTRAINT application_consent_requests_permissions_bound CHECK (
    cardinality(requested_permissions)<=128 AND array_position(requested_permissions,NULL) IS NULL
  ),
  CONSTRAINT application_consent_requests_verification_bound CHECK (
    jsonb_typeof(permission_verification)='object'
    AND octet_length(permission_verification::text)<=32768
    AND permission_verification::text !~* '"[^"]*(secret|password|access[ _-]?token|refresh[ _-]?token|private[ _-]?key|api[ _-]?key|cookie)[^"]*"[[:space:]]*:'
  )
);
CREATE INDEX application_consent_requests_expiry_idx
  ON finnor_os.application_consent_requests(expires_at) WHERE consumed_at IS NULL;
CREATE INDEX application_consent_requests_tenant_profile_idx
  ON finnor_os.application_consent_requests(tenant_id,auth_profile_id,created_at DESC);

CREATE OR REPLACE FUNCTION finnor_os.consume_application_consent_request(
  p_state_hash text,
  p_returned_directory_tenant_id text,
  p_succeeded boolean
) RETURNS TABLE(
  request_id uuid, tenant_id uuid, auth_profile_id uuid, actor_id uuid,
  provider text, expected_directory_tenant_id text, redirect_uri text,
  requested_permissions text[]
) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  RETURN QUERY
    UPDATE finnor_os.application_consent_requests r
       SET consumed_at=clock_timestamp(),
           returned_directory_tenant_id=p_returned_directory_tenant_id,
           status=CASE WHEN p_succeeded THEN 'returned' ELSE 'failed' END,
           updated_at=clock_timestamp()
     WHERE r.state_hash=p_state_hash
       AND r.consumed_at IS NULL
       AND r.expires_at>clock_timestamp()
       AND (NOT p_succeeded OR lower(r.expected_directory_tenant_id)=lower(p_returned_directory_tenant_id))
    RETURNING r.id,r.tenant_id,r.auth_profile_id,r.actor_id,r.provider,
      r.expected_directory_tenant_id,r.redirect_uri,r.requested_permissions;
END $$;

-- ---------------------------------------------------------------------------
-- Exact source scopes. These rows define provider coverage units, not PE state.
-- ---------------------------------------------------------------------------
CREATE TABLE finnor_os.integration_source_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  integration_id uuid NOT NULL,
  provider text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN (
    'outlook_mail_folder','outlook_calendar_view','teams_channel','teams_chat',
    'teams_user_chat_feed','teams_transcript_organizer','sharepoint_drive','sharepoint_list'
  )),
  provider_scope_type text NOT NULL CHECK (btrim(provider_scope_type)<>'' AND length(provider_scope_type)<=80),
  provider_resource_id text NOT NULL CHECK (btrim(provider_resource_id)<>'' AND length(provider_resource_id)<=512),
  provider_parent_id text CHECK (provider_parent_id IS NULL OR (btrim(provider_parent_id)<>'' AND length(provider_parent_id)<=512)),
  scope_key text NOT NULL CHECK (btrim(scope_key)<>'' AND length(scope_key)<=160),
  enabled boolean NOT NULL DEFAULT true,
  root_binding_type text CHECK (root_binding_type IS NULL OR root_binding_type IN ('pe_strategy','pe_opportunity','pe_deal')),
  root_binding_id uuid,
  sync_strategy text NOT NULL CHECK (sync_strategy IN ('delta','bounded_enumeration','exact_read')),
  recovery_strategy text NOT NULL CHECK (recovery_strategy IN (
    'EXACT_DELTA','BOUNDED_RECONCILIATION','BEST_EFFORT_NOTIFICATION_RECOVERY'
  )),
  permission_mode text NOT NULL DEFAULT 'SCOPED' CHECK (permission_mode IN ('SCOPED','BROAD')),
  required_permissions text[] NOT NULL DEFAULT '{}',
  effective_permissions text[] NOT NULL DEFAULT '{}',
  provider_restriction_method text,
  permission_verified_at timestamptz,
  coverage_policy jsonb NOT NULL DEFAULT '{}',
  freshness_policy jsonb NOT NULL DEFAULT '{}',
  configuration jsonb NOT NULL DEFAULT '{}',
  freshness_state text NOT NULL DEFAULT 'unknown' CHECK (freshness_state IN ('unknown','fresh','stale','expired')),
  last_sync_started_at timestamptz,
  last_successful_sync_at timestamptz,
  last_observed_at timestamptz,
  configured_by text NOT NULL CHECK (btrim(configured_by)<>'' AND length(configured_by)<=160),
  configured_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_source_scopes_tenant_id_id_key UNIQUE (tenant_id,id),
  CONSTRAINT integration_source_scopes_tenant_integration_id_key UNIQUE (tenant_id,integration_id,id),
  CONSTRAINT integration_source_scopes_identity_key UNIQUE (tenant_id,integration_id,scope_key),
  CONSTRAINT integration_source_scopes_integration_tenant_fkey
    FOREIGN KEY (tenant_id,integration_id) REFERENCES finnor_os.tenant_integrations(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT integration_source_scopes_provider_check CHECK (provider='microsoft_graph'),
  CONSTRAINT integration_source_scopes_root_pair_check CHECK ((root_binding_type IS NULL)=(root_binding_id IS NULL)),
  CONSTRAINT integration_source_scopes_disable_pair_check CHECK (enabled=(disabled_at IS NULL)),
  CONSTRAINT integration_source_scopes_permissions_bound CHECK (
    cardinality(required_permissions)<=128 AND cardinality(effective_permissions)<=128
    AND array_position(required_permissions,NULL) IS NULL AND array_position(effective_permissions,NULL) IS NULL
  ),
  CONSTRAINT integration_source_scopes_json_bound CHECK (
    jsonb_typeof(coverage_policy)='object' AND octet_length(coverage_policy::text)<=32768
    AND jsonb_typeof(freshness_policy)='object' AND octet_length(freshness_policy::text)<=16384
    AND jsonb_typeof(configuration)='object' AND octet_length(configuration::text)<=65536
    AND jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=32768
  ),
  CONSTRAINT integration_source_scopes_no_secrets CHECK (
    (coverage_policy::text||freshness_policy::text||configuration::text||metadata::text)
      !~* '"[^"]*(secret|password|access[ _-]?token|refresh[ _-]?token|private[ _-]?key|api[ _-]?key|cookie)[^"]*"[[:space:]]*:'
  ),
  CONSTRAINT integration_source_scopes_strategy_check CHECK (
    (source_kind IN ('outlook_mail_folder','outlook_calendar_view','teams_user_chat_feed','teams_transcript_organizer','sharepoint_drive','sharepoint_list')
      AND sync_strategy='delta' AND recovery_strategy='EXACT_DELTA')
    OR (source_kind IN ('teams_channel','teams_chat')
      AND sync_strategy='bounded_enumeration'
      AND recovery_strategy IN ('BOUNDED_RECONCILIATION','BEST_EFFORT_NOTIFICATION_RECOVERY'))
  )
);
CREATE INDEX integration_source_scopes_integration_kind_idx
  ON finnor_os.integration_source_scopes(tenant_id,integration_id,source_kind,enabled);
CREATE INDEX integration_source_scopes_root_idx
  ON finnor_os.integration_source_scopes(tenant_id,root_binding_type,root_binding_id,enabled)
  WHERE root_binding_id IS NOT NULL;

CREATE OR REPLACE FUNCTION finnor_os.assert_provider_world_root() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE root_type text; root_id uuid; root_tenant uuid; scope_row record;
BEGIN
  IF TG_TABLE_NAME='integration_source_scopes' THEN
    root_type:=NEW.root_binding_type; root_id:=NEW.root_binding_id;
  ELSE
    root_type:=NEW.world_root_type; root_id:=NEW.world_root_id;
    IF NEW.source_scope_id IS NOT NULL THEN
      SELECT tenant_id,integration_id,provider INTO scope_row
        FROM finnor_os.integration_source_scopes WHERE id=NEW.source_scope_id;
      IF NOT FOUND OR scope_row.tenant_id IS DISTINCT FROM NEW.tenant_id
         OR scope_row.integration_id IS DISTINCT FROM NEW.integration_id
         OR scope_row.provider IS DISTINCT FROM NEW.provider THEN
        RAISE EXCEPTION 'provider root binding source scope crosses tenant/integration/provider boundary';
      END IF;
    END IF;
  END IF;
  IF root_type IS NULL AND root_id IS NULL THEN RETURN NEW; END IF;
  IF root_type NOT IN ('pe_strategy','pe_opportunity','pe_deal') OR root_id IS NULL THEN
    RAISE EXCEPTION 'provider root binding has an unsupported or incomplete PE root';
  END IF;
  root_tenant:=finnor_os.canonical_entity_tenant(root_type,root_id);
  IF root_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'provider root binding crosses tenant boundary or root is missing';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_source_scopes_root_guard
  BEFORE INSERT OR UPDATE ON finnor_os.integration_source_scopes
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_provider_world_root();

ALTER TABLE finnor_os.integration_sync_checkpoints ADD COLUMN source_scope_id uuid;
ALTER TABLE finnor_os.integration_sync_checkpoints ADD CONSTRAINT integration_sync_checkpoints_scope_identity_fkey
  FOREIGN KEY (tenant_id,integration_id,source_scope_id)
  REFERENCES finnor_os.integration_source_scopes(tenant_id,integration_id,id) ON DELETE CASCADE;
CREATE UNIQUE INDEX integration_sync_checkpoints_source_scope_once_idx
  ON finnor_os.integration_sync_checkpoints(source_scope_id) WHERE source_scope_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Historical coverage facts. Freshness remains separate current telemetry.
-- ---------------------------------------------------------------------------
CREATE TABLE finnor_os.integration_source_coverage_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  source_scope_id uuid NOT NULL,
  coverage_revision integer NOT NULL CHECK (coverage_revision>=1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  coverage_region jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL CHECK (state IN (
    'INITIALIZING','COMPLETE','PARTIAL','RECOVERING','BLOCKED_AUTH',
    'BLOCKED_PERMISSION','HISTORY_LIMITED','NOT_CONFIGURED','DISABLED'
  )),
  reason text,
  checkpoint_id uuid,
  baseline_started_at timestamptz,
  baseline_completed_at timestamptz,
  earliest_provider_at timestamptz,
  latest_provider_at timestamptz,
  unresolved_observations integer NOT NULL DEFAULT 0 CHECK (unresolved_observations>=0),
  ambiguous_observations integer NOT NULL DEFAULT 0 CHECK (ambiguous_observations>=0),
  metadata jsonb NOT NULL DEFAULT '{}',
  CONSTRAINT integration_source_coverage_history_scope_revision_key UNIQUE (source_scope_id,coverage_revision),
  CONSTRAINT integration_source_coverage_history_scope_tenant_fkey
    FOREIGN KEY (tenant_id,source_scope_id) REFERENCES finnor_os.integration_source_scopes(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT integration_source_coverage_history_checkpoint_tenant_fkey
    FOREIGN KEY (tenant_id,checkpoint_id) REFERENCES finnor_os.integration_sync_checkpoints(tenant_id,id),
  CONSTRAINT integration_source_coverage_history_interval_check CHECK (effective_to IS NULL OR effective_to>effective_from),
  CONSTRAINT integration_source_coverage_history_baseline_check CHECK (
    baseline_completed_at IS NULL OR (baseline_started_at IS NOT NULL AND baseline_completed_at>=baseline_started_at)
  ),
  CONSTRAINT integration_source_coverage_history_region_bound CHECK (
    jsonb_typeof(coverage_region)='object' AND octet_length(coverage_region::text)<=65536
  ),
  CONSTRAINT integration_source_coverage_history_metadata_bound CHECK (
    jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=32768
  )
);
CREATE INDEX integration_source_coverage_history_asof_idx
  ON finnor_os.integration_source_coverage_history(tenant_id,source_scope_id,effective_from DESC,recorded_at DESC);

CREATE OR REPLACE FUNCTION finnor_os.assert_source_coverage_append() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE prior record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':'||NEW.source_scope_id::text,5112));
  SELECT coverage_revision,effective_from,recorded_at INTO prior
    FROM finnor_os.integration_source_coverage_history
   WHERE source_scope_id=NEW.source_scope_id
   ORDER BY coverage_revision DESC LIMIT 1;
  IF NEW.coverage_revision<>coalesce(prior.coverage_revision,0)+1 THEN
    RAISE EXCEPTION 'source coverage revision must append contiguously';
  END IF;
  IF prior.coverage_revision IS NOT NULL AND NEW.effective_from<prior.effective_from THEN
    RAISE EXCEPTION 'source coverage effective time cannot move backwards';
  END IF;
  IF prior.coverage_revision IS NOT NULL AND NEW.recorded_at<prior.recorded_at THEN
    RAISE EXCEPTION 'source coverage recorded time cannot move backwards';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_source_coverage_history_append_guard
  BEFORE INSERT ON finnor_os.integration_source_coverage_history
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_source_coverage_append();
CREATE TRIGGER integration_source_coverage_history_immutable
  BEFORE UPDATE OR DELETE ON finnor_os.integration_source_coverage_history
  FOR EACH ROW EXECUTE FUNCTION finnor_os.forbid_canonical_history_mutation();

-- ---------------------------------------------------------------------------
-- Durable notification subscription control plane.
-- ---------------------------------------------------------------------------
CREATE TABLE finnor_os.integration_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  integration_id uuid NOT NULL,
  source_scope_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider='microsoft_graph'),
  provider_subscription_id text,
  resource text NOT NULL CHECK (btrim(resource)<>'' AND length(resource)<=2048),
  change_types text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'provisioning' CHECK (status IN (
    'provisioning','active','renewing','degraded','reauthorization_required',
    'removed','expired','deleting','disabled'
  )),
  expiration_at timestamptz,
  renew_at timestamptz,
  created_at_provider timestamptz,
  last_renewed_at timestamptz,
  last_notification_at timestamptz,
  last_lifecycle_event_at timestamptz,
  client_state_hash text NOT NULL CHECK (client_state_hash ~ '^[0-9a-f]{64}$'),
  failure_code text,
  recovery_state text NOT NULL DEFAULT 'none' CHECK (recovery_state IN ('none','required','running','converged','partial','failed')),
  lease_owner text,
  lease_expires_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_subscriptions_tenant_id_id_key UNIQUE (tenant_id,id),
  CONSTRAINT integration_subscriptions_integration_tenant_fkey
    FOREIGN KEY (tenant_id,integration_id) REFERENCES finnor_os.tenant_integrations(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT integration_subscriptions_scope_identity_fkey
    FOREIGN KEY (tenant_id,integration_id,source_scope_id)
    REFERENCES finnor_os.integration_source_scopes(tenant_id,integration_id,id) ON DELETE CASCADE,
  CONSTRAINT integration_subscriptions_change_types_bound CHECK (
    cardinality(change_types) BETWEEN 1 AND 8 AND array_position(change_types,NULL) IS NULL
  ),
  CONSTRAINT integration_subscriptions_expiration_pair_check CHECK (
    (expiration_at IS NULL AND renew_at IS NULL) OR (expiration_at IS NOT NULL AND renew_at IS NOT NULL AND renew_at<expiration_at)
  ),
  CONSTRAINT integration_subscriptions_lease_pair_check CHECK ((lease_owner IS NULL)=(lease_expires_at IS NULL)),
  CONSTRAINT integration_subscriptions_metadata_bound CHECK (
    jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=32768
    AND metadata::text !~* '"[^"]*(secret|password|access[ _-]?token|refresh[ _-]?token|private[ _-]?key|api[ _-]?key|client[ _-]?state|cookie)[^"]*"[[:space:]]*:'
  )
);
CREATE UNIQUE INDEX integration_subscriptions_provider_id_key
  ON finnor_os.integration_subscriptions(provider,provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;
CREATE INDEX integration_subscriptions_due_idx
  ON finnor_os.integration_subscriptions(provider,status,renew_at,lease_expires_at);
CREATE INDEX integration_subscriptions_scope_idx
  ON finnor_os.integration_subscriptions(tenant_id,source_scope_id,status);

CREATE OR REPLACE FUNCTION finnor_os.assert_integration_subscription_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE scope_row record;
BEGIN
  SELECT tenant_id,integration_id,provider,enabled INTO scope_row
    FROM finnor_os.integration_source_scopes WHERE id=NEW.source_scope_id;
  IF NOT FOUND OR scope_row.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR scope_row.integration_id IS DISTINCT FROM NEW.integration_id
     OR scope_row.provider IS DISTINCT FROM NEW.provider THEN
    RAISE EXCEPTION 'subscription crosses tenant/integration/provider source scope';
  END IF;
  IF NEW.status IN ('active','renewing') AND (NEW.provider_subscription_id IS NULL OR NEW.expiration_at IS NULL) THEN
    RAISE EXCEPTION 'active subscription requires provider identity and expiration';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_subscriptions_scope_guard
  BEFORE INSERT OR UPDATE ON finnor_os.integration_subscriptions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_integration_subscription_scope();

-- ---------------------------------------------------------------------------
-- Small provider-neutral deterministic object/thread -> P1 root proof.
-- ---------------------------------------------------------------------------
CREATE TABLE finnor_os.provider_object_root_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  integration_id uuid NOT NULL,
  source_scope_id uuid,
  provider text NOT NULL CHECK (provider='microsoft_graph'),
  resource_kind text NOT NULL CHECK (btrim(resource_kind)<>'' AND length(resource_kind)<=80),
  external_object_type text NOT NULL CHECK (btrim(external_object_type)<>'' AND length(external_object_type)<=120),
  external_object_id text NOT NULL CHECK (btrim(external_object_id)<>'' AND length(external_object_id)<=1024),
  binding_level text NOT NULL CHECK (binding_level IN ('object','document','parent','thread','series','meeting')),
  world_root_type text NOT NULL CHECK (world_root_type IN ('pe_strategy','pe_opportunity','pe_deal')),
  world_root_id uuid NOT NULL,
  binding_source text NOT NULL CHECK (binding_source IN (
    'explicit','source_scope','core_document','external_ref','parent_inheritance',
    'conversation_inheritance','meeting_inheritance'
  )),
  created_by text NOT NULL CHECK (btrim(created_by)<>'' AND length(created_by)<=160),
  supersedes_binding_id uuid,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_object_root_bindings_tenant_id_id_key UNIQUE (tenant_id,id),
  CONSTRAINT provider_object_root_bindings_supersedes_key UNIQUE (supersedes_binding_id),
  CONSTRAINT provider_object_root_bindings_integration_tenant_fkey
    FOREIGN KEY (tenant_id,integration_id) REFERENCES finnor_os.tenant_integrations(tenant_id,id),
  CONSTRAINT provider_object_root_bindings_scope_identity_fkey
    FOREIGN KEY (tenant_id,integration_id,source_scope_id)
    REFERENCES finnor_os.integration_source_scopes(tenant_id,integration_id,id),
  CONSTRAINT provider_object_root_bindings_supersedes_tenant_fkey
    FOREIGN KEY (tenant_id,supersedes_binding_id)
    REFERENCES finnor_os.provider_object_root_bindings(tenant_id,id)
);
CREATE UNIQUE INDEX provider_object_root_bindings_active_identity_key
  ON finnor_os.provider_object_root_bindings(
    tenant_id,integration_id,resource_kind,external_object_type,external_object_id,binding_level
  ) WHERE superseded_at IS NULL;
CREATE INDEX provider_object_root_bindings_root_idx
  ON finnor_os.provider_object_root_bindings(tenant_id,world_root_type,world_root_id,superseded_at);
CREATE TRIGGER provider_object_root_bindings_root_guard
  BEFORE INSERT OR UPDATE ON finnor_os.provider_object_root_bindings
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_provider_world_root();

CREATE OR REPLACE FUNCTION finnor_os.guard_provider_root_binding_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'provider root bindings retain history'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.integration_id IS DISTINCT FROM OLD.integration_id
     OR NEW.source_scope_id IS DISTINCT FROM OLD.source_scope_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.resource_kind IS DISTINCT FROM OLD.resource_kind
     OR NEW.external_object_type IS DISTINCT FROM OLD.external_object_type
     OR NEW.external_object_id IS DISTINCT FROM OLD.external_object_id
     OR NEW.binding_level IS DISTINCT FROM OLD.binding_level
     OR NEW.world_root_type IS DISTINCT FROM OLD.world_root_type
     OR NEW.world_root_id IS DISTINCT FROM OLD.world_root_id
     OR NEW.binding_source IS DISTINCT FROM OLD.binding_source
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.supersedes_binding_id IS DISTINCT FROM OLD.supersedes_binding_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION 'provider root binding identity is immutable; only one-way supersession is allowed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provider_object_root_bindings_history_guard
  BEFORE UPDATE OR DELETE ON finnor_os.provider_object_root_bindings
  FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_provider_root_binding_history();

-- ---------------------------------------------------------------------------
-- Extend P1's immutable observation ledger; external_refs remains projection.
-- observed_hash is the ProviderObservation payloadHash for these rows.
-- ---------------------------------------------------------------------------
ALTER TABLE finnor_os.external_ref_observations
  ALTER COLUMN canonical_entity_type DROP NOT NULL,
  ADD COLUMN source_scope_id uuid,
  ADD COLUMN resource_kind text,
  ADD COLUMN retrieved_at timestamptz,
  ADD COLUMN observation_key text,
  ADD COLUMN provider_parent_refs jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN provider_metadata jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN ingestion_mode text,
  ADD COLUMN trace_id text,
  ADD COLUMN evidence_source_id uuid,
  ADD COLUMN evidence_version_id uuid;

ALTER TABLE finnor_os.external_ref_observations DROP CONSTRAINT IF EXISTS external_ref_observations_canonical_entity_type_check;
ALTER TABLE finnor_os.external_ref_observations ADD CONSTRAINT external_ref_observations_canonical_entity_type_check
  CHECK (canonical_entity_type IS NULL OR btrim(canonical_entity_type)<>'');
ALTER TABLE finnor_os.external_ref_observations DROP CONSTRAINT IF EXISTS external_ref_observations_materialization_status_check;
ALTER TABLE finnor_os.external_ref_observations ADD CONSTRAINT external_ref_observations_materialization_status_check
  CHECK (materialization_status IN (
    'acknowledged','observed','mapped','evidence_only','created','updated','unchanged','duplicate',
    'out_of_order','ambiguous','unresolved','conflict','tombstoned','ignored','rejected'
  ));
ALTER TABLE finnor_os.external_ref_observations ADD CONSTRAINT external_ref_observations_ingestion_mode_check
  CHECK (ingestion_mode IS NULL OR ingestion_mode IN ('initial_backfill','incremental','recovery','exact_read'));
ALTER TABLE finnor_os.external_ref_observations ADD CONSTRAINT external_ref_observations_observation_key_check
  CHECK (observation_key IS NULL OR observation_key ~ '^[0-9a-f]{64}$');
ALTER TABLE finnor_os.external_ref_observations ADD CONSTRAINT external_ref_observations_provider_fields_bound CHECK (
  jsonb_typeof(provider_parent_refs)='array' AND jsonb_array_length(provider_parent_refs)<=32
  AND octet_length(provider_parent_refs::text)<=32768
  AND jsonb_typeof(provider_metadata)='object' AND octet_length(provider_metadata::text)<=32768
);
ALTER TABLE finnor_os.external_ref_observations ADD CONSTRAINT external_ref_observations_microsoft_shape_check CHECK (
  provider<>'microsoft_graph' OR (
    source_scope_id IS NOT NULL AND resource_kind IS NOT NULL AND btrim(resource_kind)<>''
    AND retrieved_at IS NOT NULL AND observation_key IS NOT NULL
    AND ingestion_mode IS NOT NULL AND trace_id IS NOT NULL AND btrim(trace_id)<>''
    AND evidence_source_id IS NOT NULL AND evidence_version_id IS NOT NULL
  )
);
ALTER TABLE finnor_os.external_ref_observations ADD CONSTRAINT external_ref_observations_scope_identity_fkey
  FOREIGN KEY (tenant_id,integration_id,source_scope_id)
  REFERENCES finnor_os.integration_source_scopes(tenant_id,integration_id,id);
ALTER TABLE finnor_os.external_ref_observations ADD CONSTRAINT external_ref_observations_evidence_source_fkey
  FOREIGN KEY (evidence_source_id) REFERENCES finnor_os.evidence_sources(id);
ALTER TABLE finnor_os.external_ref_observations ADD CONSTRAINT external_ref_observations_evidence_version_fkey
  FOREIGN KEY (evidence_version_id) REFERENCES finnor_os.evidence_source_versions(id);
CREATE UNIQUE INDEX external_ref_observations_observation_key
  ON finnor_os.external_ref_observations(tenant_id,integration_id,observation_key)
  WHERE observation_key IS NOT NULL;
CREATE INDEX external_ref_observations_scope_retrieved_idx
  ON finnor_os.external_ref_observations(tenant_id,source_scope_id,retrieved_at,id)
  WHERE source_scope_id IS NOT NULL;

CREATE OR REPLACE FUNCTION finnor_os.assert_provider_observation_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE scope_row record; source_row record; version_row record;
BEGIN
  IF NEW.source_scope_id IS NOT NULL THEN
    SELECT tenant_id,integration_id,provider INTO scope_row
      FROM finnor_os.integration_source_scopes WHERE id=NEW.source_scope_id;
    IF NOT FOUND OR scope_row.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR scope_row.integration_id IS DISTINCT FROM NEW.integration_id
       OR scope_row.provider IS DISTINCT FROM NEW.provider THEN
      RAISE EXCEPTION 'provider observation crosses tenant/integration/provider source scope';
    END IF;
  END IF;
  IF NEW.evidence_source_id IS NOT NULL OR NEW.evidence_version_id IS NOT NULL THEN
    SELECT scope,tenant_id INTO source_row FROM finnor_os.evidence_sources WHERE id=NEW.evidence_source_id;
    SELECT source_id,scope,tenant_id INTO version_row FROM finnor_os.evidence_source_versions WHERE id=NEW.evidence_version_id;
    IF NOT FOUND OR source_row.scope<>'tenant' OR source_row.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR version_row.source_id IS DISTINCT FROM NEW.evidence_source_id
       OR version_row.scope<>'tenant' OR version_row.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'provider observation evidence crosses tenant/source/version boundary';
    END IF;
  END IF;
  IF NEW.canonical_entity_id IS NOT NULL
     AND finnor_os.canonical_entity_tenant(NEW.canonical_entity_type,NEW.canonical_entity_id) IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'provider observation canonical mapping crosses tenant boundary or is missing';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER external_ref_observations_provider_scope_guard
  BEFORE INSERT ON finnor_os.external_ref_observations
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_provider_observation_scope();

ALTER TABLE finnor_os.reconciliation_cases DROP CONSTRAINT IF EXISTS reconciliation_cases_case_type_check;
ALTER TABLE finnor_os.reconciliation_cases ADD CONSTRAINT reconciliation_cases_case_type_check CHECK (case_type IN (
  'unknown_delivery','unmatched_inbox_event','external_drift','mapping_ambiguous','stale_source','auth_failure',
  'unresolved_world_root','coverage_gap','provider_permission_drift','delete_unverified'
));

-- ---------------------------------------------------------------------------
-- Tenant isolation, least privilege, and retained control-plane history.
-- ---------------------------------------------------------------------------

-- P1 linked generic evidence directly to Strategy/Opportunity worlds but its
-- evidence-link allowlist omitted the Deal root itself. P2 evidence-only
-- observations need the same exact root attachment without inventing a Finding.
ALTER TABLE finnor_os.pe_evidence_links DROP CONSTRAINT IF EXISTS pe_evidence_links_entity_type_check;
ALTER TABLE finnor_os.pe_evidence_links ADD CONSTRAINT pe_evidence_links_entity_type_check CHECK (entity_type IN (
  'pe_deal','pe_finding','pe_deal_risk','pe_closing_condition','pe_closing_item',
  'pe_strategy','pe_opportunity','pe_investment_case','pe_thesis','pe_assumption','pe_decision'
));

-- Core Document remains the sole file identity owner. This narrow provider key
-- makes drive-item replay and rename converge on the same Document without
-- imposing a new uniqueness contract on historical providers.
CREATE UNIQUE INDEX documents_microsoft_graph_identity_key
  ON finnor_os.documents(tenant_id,external_id)
  WHERE source_system='microsoft_graph' AND external_id IS NOT NULL;

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'application_consent_requests','integration_source_scopes',
    'integration_source_coverage_history','integration_subscriptions',
    'provider_object_root_bindings'
  ] LOOP
    EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON finnor_os.%I USING (tenant_id=finnor_os.request_tenant_id()) WITH CHECK (tenant_id=finnor_os.request_tenant_id())',
      table_name
    );
  END LOOP;
END $rls$;

REVOKE ALL ON finnor_os.application_consent_requests,
  finnor_os.integration_source_scopes,
  finnor_os.integration_source_coverage_history,
  finnor_os.integration_subscriptions,
  finnor_os.provider_object_root_bindings FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.consume_application_consent_request(text,text,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.assert_provider_world_root() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.assert_source_coverage_append() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.assert_integration_subscription_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.guard_provider_root_binding_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.assert_provider_observation_scope() FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    GRANT SELECT,INSERT,UPDATE ON finnor_os.application_consent_requests,
      finnor_os.integration_source_scopes,
      finnor_os.integration_subscriptions,
      finnor_os.provider_object_root_bindings TO finnor_app;
    REVOKE DELETE ON finnor_os.application_consent_requests,
      finnor_os.integration_source_scopes,
      finnor_os.integration_subscriptions,
      finnor_os.provider_object_root_bindings FROM finnor_app;
    GRANT SELECT,INSERT ON finnor_os.integration_source_coverage_history TO finnor_app;
    REVOKE UPDATE,DELETE ON finnor_os.integration_source_coverage_history FROM finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.consume_application_consent_request(text,text,boolean) TO finnor_app;
  END IF;
END $grants$;

COMMENT ON TABLE finnor_os.integration_source_scopes IS
  'Exact authorized provider coverage units; no PE business ownership and no secret material.';
COMMENT ON TABLE finnor_os.integration_source_coverage_history IS
  'Append-only historical coverage truth, intentionally separate from source freshness.';
COMMENT ON TABLE finnor_os.integration_subscriptions IS
  'Graph notification control plane. Notifications wake sync; rows are not Evidence or BusinessEvents.';
COMMENT ON TABLE finnor_os.provider_object_root_bindings IS
  'Deterministic provider object/thread to existing P1 PE root proof; fuzzy and LLM mappings are forbidden.';
COMMENT ON TABLE finnor_os.application_consent_requests IS
  'Administrative application-consent proof only; runtime identity remains app-only workload federation.';
