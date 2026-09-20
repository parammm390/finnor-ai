-- Scope 3: one canonical jobs store with trusted instance classification,
-- class-isolated claiming, durable fairness, bounded singleton ownership, and an
-- explicit rolling-cutover fence.  Scope-1 business semantics and Scope-2
-- delivery/effect truth are not re-owned here.

CREATE TABLE finnor_os.compute_job_type_policies (
  job_type text PRIMARY KEY,
  default_class text NOT NULL CHECK (default_class IN ('REALTIME','INTERACTIVE','BACKGROUND','HEAVY')),
  allowed_classes text[] NOT NULL,
  classification_rule text NOT NULL CHECK (classification_rule IN ('fixed','trusted_lane')),
  tenant_scope text NOT NULL CHECK (tenant_scope IN ('tenant','global')),
  obligation_kind text NOT NULL CHECK (obligation_kind IN ('required','coalescible')),
  policy_revision integer NOT NULL CHECK (policy_revision > 0),
  rationale text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (cardinality(allowed_classes) > 0),
  CHECK (default_class = ANY(allowed_classes)),
  CHECK (allowed_classes <@ ARRAY['REALTIME','INTERACTIVE','BACKGROUND','HEAVY']::text[])
);

INSERT INTO finnor_os.compute_job_type_policies(
  job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale
) VALUES
  ('reconciliation','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,'Provider events may unblock an actively observed effect.'),
  ('process_instruction','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,'An accepted user instruction has a near-term response dependency.'),
  ('run_workflow_step','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,'Scope-2 workflow execution advances accepted Work.'),
  ('run_workflow_step_v2','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,'Versioned Scope-2 workflow execution advances accepted Work.'),
  ('critic_review','BACKGROUND',ARRAY['BACKGROUND'],'fixed','tenant','required',1,'An asynchronous second opinion does not gate durable acceptance.'),
  ('learning_digest','BACKGROUND',ARRAY['BACKGROUND'],'fixed','tenant','coalescible',1,'Daily learning aggregation is scheduled maintenance.'),
  ('scan_approval_expiry','BACKGROUND',ARRAY['BACKGROUND'],'fixed','tenant','coalescible',1,'Scheduled approval hygiene.'),
  ('scan_reliability_alerts','BACKGROUND',ARRAY['BACKGROUND'],'fixed','tenant','coalescible',1,'Scheduled reliability detection.'),
  ('scan_integration_health','BACKGROUND',ARRAY['BACKGROUND'],'fixed','tenant','coalescible',1,'Scheduled provider health probes.'),
  ('scan_watchdog','BACKGROUND',ARRAY['BACKGROUND'],'fixed','tenant','coalescible',1,'Scheduled recovery discovery.'),
  ('scan_dlq_triage','BACKGROUND',ARRAY['BACKGROUND'],'fixed','tenant','coalescible',1,'Asynchronous operational maintenance.'),
  ('daily_scorecard','BACKGROUND',ARRAY['BACKGROUND'],'fixed','tenant','coalescible',1,'Daily scorecard projection.'),
  ('project_read_models','BACKGROUND',ARRAY['BACKGROUND'],'fixed','tenant','coalescible',1,'Periodic projection backstop.'),
  ('repair_plan_after_terminal_failure','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,'Repair resumes already accepted Work.'),
  ('purge_retention','HEAVY',ARRAY['HEAVY'],'fixed','tenant','coalescible',1,'Bounded bulk deletes and scrubbing inside a transaction.'),
  ('run_objective_iteration','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,'Active Scope-1 objective controller.'),
  ('run_workforce_assignment','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,'Accepted workforce assignment.'),
  ('recover_objectives','BACKGROUND',ARRAY['BACKGROUND'],'fixed','tenant','coalescible',1,'Scheduled bounded objective recovery.'),
  ('run_computer_task','HEAVY',ARRAY['HEAVY'],'fixed','tenant','required',1,'Long-lived browser and provider capacity.'),
  ('recover_computer_tasks','BACKGROUND',ARRAY['BACKGROUND'],'fixed','tenant','coalescible',1,'Orphan discovery for heavy computer work.'),
  ('process_work_event_wait_deadline','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,'A durable wait deadline resumes accepted Work.'),
  ('scan_connection_health','BACKGROUND',ARRAY['BACKGROUND'],'fixed','tenant','coalescible',1,'Scheduled connection health maintenance.'),
  ('release_probe','REALTIME',ARRAY['REALTIME'],'fixed','global','coalescible',1,'Side-effect-free proof for the ingress-owning realtime service.'),
  ('sync_sources','BACKGROUND',ARRAY['BACKGROUND'],'fixed','tenant','coalescible',1,'Scheduled source-discovery fan-out.'),
  ('sync_source','BACKGROUND',ARRAY['BACKGROUND','INTERACTIVE'],'trusted_lane','tenant','required',1,'Scheduled sync is background; trusted unblock sync may be interactive.'),
  ('observe_external_effect','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,'Observation resolves an accepted Scope-2 effect outcome.'),
  ('maintain_integration_subscriptions','BACKGROUND',ARRAY['BACKGROUND','INTERACTIVE'],'trusted_lane','tenant','required',1,'Routine renewal is background; trusted setup convergence may be interactive.'),
  ('materialize_artifact_version','HEAVY',ARRAY['HEAVY'],'fixed','tenant','required',1,'High-byte artifact download, compile, and upload path.');

CREATE TABLE finnor_os.compute_plane_cutover (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  state text NOT NULL CHECK (state IN ('preparing','authoritative')) DEFAULT 'preparing',
  accepted_job_epoch integer NOT NULL DEFAULT 1 CHECK (accepted_job_epoch BETWEEN 1 AND 1000),
  minimum_claim_epoch integer NOT NULL DEFAULT 1 CHECK (minimum_claim_epoch BETWEEN 1 AND 1000),
  enforce_known_job_types boolean NOT NULL DEFAULT false,
  legacy_tenant_writes_allowed boolean NOT NULL DEFAULT true,
  activated_release_sha text,
  activated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state='preparing' AND activated_at IS NULL)
      OR (state='authoritative' AND accepted_job_epoch>=3 AND minimum_claim_epoch>=3
          AND enforce_known_job_types AND activated_release_sha ~ '^[0-9a-f]{40}$' AND activated_at IS NOT NULL))
);
INSERT INTO finnor_os.compute_plane_cutover(singleton) VALUES(true);

ALTER TABLE finnor_os.jobs
  ADD COLUMN workload_class text NOT NULL DEFAULT 'BACKGROUND',
  ADD COLUMN classification_policy_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN classification_reason text NOT NULL DEFAULT 'legacy-safe-default:migration',
  ADD COLUMN tenant_scope text NOT NULL DEFAULT 'global',
  ADD COLUMN tenant_key text NOT NULL DEFAULT '__global__',
  ADD COLUMN tenant_identity_source text NOT NULL DEFAULT 'global',
  ADD COLUMN obligation_kind text NOT NULL DEFAULT 'required',
  ADD COLUMN required_compute_epoch integer NOT NULL DEFAULT 1,
  ADD COLUMN accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN capacity_defer_count integer NOT NULL DEFAULT 0,
  ADD COLUMN capacity_deferred_at timestamptz,
  ADD COLUMN capacity_defer_reason text;

UPDATE finnor_os.jobs j
   SET workload_class=CASE
         WHEN p.classification_rule='trusted_lane' AND j.lane='interactive'
              AND 'INTERACTIVE'=ANY(p.allowed_classes) THEN 'INTERACTIVE'
         ELSE p.default_class
       END,
       classification_policy_revision=p.policy_revision,
       classification_reason='policy:'||p.job_type||':'||p.classification_rule||':'||j.lane,
       tenant_scope=p.tenant_scope,
       tenant_key=CASE WHEN p.tenant_scope='global' THEN '__global__' ELSE coalesce(j.tenant_id::text,'__missing_tenant__') END,
       tenant_identity_source=CASE WHEN p.tenant_scope='global' THEN 'global' WHEN j.tenant_id IS NULL THEN 'missing' ELSE 'durable_column' END,
       obligation_kind=p.obligation_kind
  FROM finnor_os.compute_job_type_policies p
 WHERE p.job_type=j.type AND p.active;

-- Known tenant-scoped work without durable tenant identity is not guessed from hot
-- JSON during claims.  It remains visible as quarantined evidence for an operator.
UPDATE finnor_os.jobs j
   SET status='quarantined',
       last_error=concat_ws(E'\n',j.last_error,'SCOPE3_MIGRATION: tenant-scoped job lacks durable tenant_id'),
       tenant_scope='tenant',tenant_key='__missing_tenant__',tenant_identity_source='missing'
  FROM finnor_os.compute_job_type_policies p
 WHERE p.job_type=j.type AND p.tenant_scope='tenant' AND j.tenant_id IS NULL
   AND j.status IN ('queued','failed');

-- Unknown historical rows receive a non-privileged safe default. Only work that
-- could still execute is quarantined: completed and dead-lettered history keeps
-- its terminal status and audit meaning. Once the staged cutover becomes
-- authoritative the INSERT trigger rejects new unknown types.
UPDATE finnor_os.jobs j
   SET workload_class='BACKGROUND',classification_policy_revision=0,
       classification_reason='legacy-safe-default:unknown-job-type',
       tenant_scope=CASE WHEN tenant_id IS NULL THEN 'global' ELSE 'tenant' END,
       tenant_key=coalesce(tenant_id::text,'__global__'),
       tenant_identity_source=CASE WHEN tenant_id IS NULL THEN 'global' ELSE 'durable_column' END,
       obligation_kind='required',
       status=CASE WHEN status IN ('queued','failed') THEN 'quarantined' ELSE status END,
       last_error=CASE WHEN status IN ('queued','failed')
         THEN concat_ws(E'\n',last_error,'SCOPE3_MIGRATION: unknown historical job type requires operator reconciliation')
         ELSE last_error END
 WHERE NOT EXISTS (SELECT 1 FROM finnor_os.compute_job_type_policies p WHERE p.job_type=j.type AND p.active);

ALTER TABLE finnor_os.jobs
  ADD CONSTRAINT jobs_workload_class_check CHECK (workload_class IN ('REALTIME','INTERACTIVE','BACKGROUND','HEAVY')),
  ADD CONSTRAINT jobs_classification_revision_check CHECK (classification_policy_revision >= 0),
  ADD CONSTRAINT jobs_tenant_scope_check CHECK (tenant_scope IN ('tenant','global')),
  ADD CONSTRAINT jobs_tenant_identity_source_check CHECK (tenant_identity_source IN ('durable_column','legacy_payload','global','missing')),
  ADD CONSTRAINT jobs_tenant_scope_shape_check CHECK (
    (tenant_scope='tenant' AND tenant_id IS NOT NULL AND tenant_key=tenant_id::text)
    OR (tenant_scope='global' AND tenant_id IS NULL AND tenant_key='__global__')
    OR tenant_key='__missing_tenant__'
  ),
  ADD CONSTRAINT jobs_obligation_kind_check CHECK (obligation_kind IN ('required','coalescible')),
  ADD CONSTRAINT jobs_required_compute_epoch_check CHECK (required_compute_epoch BETWEEN 1 AND 1000),
  ADD CONSTRAINT jobs_capacity_defer_count_check CHECK (capacity_defer_count >= 0);

CREATE INDEX jobs_class_claim_idx
  ON finnor_os.jobs(workload_class,status,run_at,priority DESC,tenant_key,id)
  WHERE status='queued';
CREATE INDEX jobs_class_tenant_due_idx
  ON finnor_os.jobs(workload_class,tenant_key,run_at,id)
  WHERE status='queued';
CREATE INDEX jobs_class_expired_lease_idx
  ON finnor_os.jobs(workload_class,lease_expires_at,id)
  WHERE status='running';
CREATE INDEX jobs_class_tenant_running_idx
  ON finnor_os.jobs(workload_class,tenant_key,status,id)
  WHERE status='running';
CREATE INDEX jobs_class_terminal_metrics_idx
  ON finnor_os.jobs(workload_class,completed_at,id)
  WHERE status IN ('completed','dead_letter','quarantined');

CREATE TABLE finnor_os.compute_tenant_claim_state (
  workload_class text NOT NULL CHECK (workload_class IN ('REALTIME','INTERACTIVE','BACKGROUND','HEAVY')),
  tenant_key text NOT NULL,
  tenant_id uuid REFERENCES finnor_os.tenants(id),
  last_claimed_at timestamptz,
  claim_count bigint NOT NULL DEFAULT 0 CHECK (claim_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workload_class,tenant_key),
  CHECK ((tenant_key='__global__' AND tenant_id IS NULL) OR tenant_key=tenant_id::text)
);
INSERT INTO finnor_os.compute_tenant_claim_state(workload_class,tenant_key,tenant_id)
SELECT DISTINCT workload_class,tenant_key,tenant_id
  FROM finnor_os.jobs
 WHERE tenant_key<>'__missing_tenant__'
ON CONFLICT DO NOTHING;

CREATE TABLE finnor_os.compute_control_leases (
  lease_name text PRIMARY KEY,
  owner_id text NOT NULL,
  lease_token uuid NOT NULL UNIQUE,
  fence bigint NOT NULL CHECK (fence > 0),
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > acquired_at)
);

CREATE TABLE finnor_os.compute_resource_policies (
  resource_key text PRIMARY KEY,
  capacity integer NOT NULL CHECK (capacity > 0),
  per_tenant_capacity integer NOT NULL CHECK (per_tenant_capacity > 0 AND per_tenant_capacity <= capacity),
  interactive_reserve integer NOT NULL DEFAULT 0 CHECK (interactive_reserve >= 0 AND interactive_reserve <= capacity),
  lease_seconds integer NOT NULL DEFAULT 60 CHECK (lease_seconds BETWEEN 15 AND 3600),
  next_fence bigint NOT NULL DEFAULT 1 CHECK (next_fence > 0),
  source text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- This is a FINNOR engineering concurrency envelope, not a claimed provider
-- quota.  Provider/model routing remains owned by the existing model plane.
INSERT INTO finnor_os.compute_resource_policies(
  resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source
) VALUES('model:global',4,2,1,60,'engineering-default:scope3-v1; configurable; not an external provider quota');
INSERT INTO finnor_os.compute_resource_policies(
  resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source
) VALUES
  ('model-provider:bedrock',3,2,1,120,'engineering-default:scope3-v1; not an AWS quota'),
  ('model-provider:groq',2,1,1,120,'engineering-default:scope3-v1; not a Groq quota'),
  ('model-provider:mistral',2,1,1,120,'engineering-default:scope3-v1; not a Mistral quota'),
  ('model-provider:deepseek',2,1,1,120,'engineering-default:scope3-v1; not a DeepSeek quota');
UPDATE finnor_os.compute_resource_policies SET lease_seconds=120 WHERE resource_key='model:global';
INSERT INTO finnor_os.compute_resource_policies(
  resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source
) VALUES('provider:microsoft-graph',8,4,2,600,
  'engineering-default:scope3-v1; bounded Graph HTTP operations; configurable; not a Microsoft quota');

ALTER TABLE finnor_os.job_delivery_attempts
  DROP CONSTRAINT job_delivery_attempts_outcome_check;
ALTER TABLE finnor_os.job_delivery_attempts
  ADD CONSTRAINT job_delivery_attempts_outcome_check CHECK (outcome IN (
    'claimed','running','completed','known_failed','lease_lost','reconciliation_required','dead_lettered','capacity_deferred','drained_before_dispatch'
  ));

CREATE TABLE finnor_os.compute_resource_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_key text NOT NULL REFERENCES finnor_os.compute_resource_policies(resource_key),
  tenant_key text NOT NULL,
  workload_class text NOT NULL CHECK (workload_class IN ('REALTIME','INTERACTIVE','BACKGROUND','HEAVY')),
  units integer NOT NULL DEFAULT 1 CHECK (units > 0),
  owner_id text NOT NULL,
  lease_token uuid NOT NULL UNIQUE,
  fence bigint NOT NULL CHECK (fence > 0),
  job_id uuid REFERENCES finnor_os.jobs(id),
  job_claim_token uuid,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  release_reason text,
  CHECK (expires_at > acquired_at),
  CHECK ((job_id IS NULL AND job_claim_token IS NULL) OR (job_id IS NOT NULL AND job_claim_token IS NOT NULL))
);
CREATE INDEX compute_resource_leases_active_idx
  ON finnor_os.compute_resource_leases(resource_key,expires_at,workload_class,tenant_key)
  WHERE released_at IS NULL;

CREATE TABLE finnor_os.compute_telemetry_publications (
  publisher_id text PRIMARY KEY,
  release_sha text NOT NULL,
  status text NOT NULL CHECK (status IN ('healthy','degraded')),
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(snapshot)='object'),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  error text
);

CREATE OR REPLACE FUNCTION finnor_os.classify_compute_job() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE
  policy finnor_os.compute_job_type_policies%ROWTYPE;
  cutover finnor_os.compute_plane_cutover%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.type IS DISTINCT FROM OLD.type OR NEW.lane IS DISTINCT FROM OLD.lane
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.workload_class IS DISTINCT FROM OLD.workload_class
       OR NEW.classification_policy_revision IS DISTINCT FROM OLD.classification_policy_revision
       OR NEW.classification_reason IS DISTINCT FROM OLD.classification_reason
       OR NEW.tenant_scope IS DISTINCT FROM OLD.tenant_scope
       OR NEW.tenant_key IS DISTINCT FROM OLD.tenant_key
       OR NEW.tenant_identity_source IS DISTINCT FROM OLD.tenant_identity_source
       OR NEW.obligation_kind IS DISTINCT FROM OLD.obligation_kind
       OR NEW.required_compute_epoch IS DISTINCT FROM OLD.required_compute_epoch THEN
      RAISE EXCEPTION 'durable job compute classification is immutable';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO cutover FROM finnor_os.compute_plane_cutover WHERE singleton FOR SHARE;
  SELECT * INTO policy FROM finnor_os.compute_job_type_policies
   WHERE job_type=NEW.type AND active;
  IF FOUND THEN
    IF policy.tenant_scope='tenant' THEN
      -- Old in-flight handlers can enqueue children while their service drains
      -- after the class claim fence activates.  A separate finalization flips
      -- this compatibility switch only after all old tasks have stopped.
      IF NEW.tenant_id IS NULL AND cutover.legacy_tenant_writes_allowed
         AND jsonb_typeof(NEW.payload->'tenantId')='string'
         AND NEW.payload->>'tenantId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        SELECT id INTO NEW.tenant_id FROM finnor_os.tenants
         WHERE id=(NEW.payload->>'tenantId')::uuid;
        NEW.tenant_identity_source := 'legacy_payload';
      ELSE
        NEW.tenant_identity_source := 'durable_column';
      END IF;
      IF NEW.tenant_id IS NULL THEN
        RAISE EXCEPTION 'tenant-scoped job % requires durable tenant_id',NEW.type;
      END IF;
    END IF;
    IF policy.tenant_scope='global' AND NEW.tenant_id IS NOT NULL THEN
      RAISE EXCEPTION 'global job % must not carry tenant_id',NEW.type;
    END IF;
    NEW.workload_class := CASE
      WHEN policy.classification_rule='trusted_lane' AND NEW.lane='interactive'
           AND 'INTERACTIVE'=ANY(policy.allowed_classes) THEN 'INTERACTIVE'
      ELSE policy.default_class END;
    NEW.classification_policy_revision := policy.policy_revision;
    NEW.classification_reason := 'policy:'||policy.job_type||':'||policy.classification_rule||':'||NEW.lane;
    NEW.tenant_scope := policy.tenant_scope;
    NEW.tenant_key := CASE WHEN policy.tenant_scope='global' THEN '__global__' ELSE NEW.tenant_id::text END;
    IF policy.tenant_scope='global' THEN NEW.tenant_identity_source := 'global'; END IF;
    NEW.obligation_kind := policy.obligation_kind;
  ELSE
    IF cutover.enforce_known_job_types THEN
      RAISE EXCEPTION 'job type % has no active compute classification policy',NEW.type;
    END IF;
    NEW.workload_class := 'BACKGROUND';
    NEW.classification_policy_revision := 0;
    NEW.classification_reason := 'legacy-safe-default:unknown-job-type';
    NEW.tenant_scope := CASE WHEN NEW.tenant_id IS NULL THEN 'global' ELSE 'tenant' END;
    NEW.tenant_key := coalesce(NEW.tenant_id::text,'__global__');
    NEW.tenant_identity_source := CASE WHEN NEW.tenant_id IS NULL THEN 'global' ELSE 'durable_column' END;
    NEW.obligation_kind := 'required';
  END IF;
  NEW.required_compute_epoch := cutover.accepted_job_epoch;
  NEW.accepted_at := coalesce(NEW.accepted_at,clock_timestamp());
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION finnor_os.classify_compute_job() FROM PUBLIC;
CREATE TRIGGER jobs_compute_classification
  BEFORE INSERT OR UPDATE OF type,lane,tenant_id,workload_class,classification_policy_revision,
    classification_reason,tenant_scope,tenant_key,tenant_identity_source,obligation_kind,required_compute_epoch
  ON finnor_os.jobs FOR EACH ROW EXECUTE FUNCTION finnor_os.classify_compute_job();

CREATE OR REPLACE FUNCTION finnor_os.guard_compute_job_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE
  cutover finnor_os.compute_plane_cutover%ROWTYPE;
  claimant_epoch integer;
  claimant_class text;
BEGIN
  IF OLD.status='queued' AND NEW.status='running' THEN
    SELECT * INTO cutover FROM finnor_os.compute_plane_cutover WHERE singleton FOR SHARE;
    claimant_epoch := coalesce(nullif(current_setting('finnor.compute_epoch',true),''),'1')::integer;
    claimant_class := nullif(current_setting('finnor.workload_class',true),'');
    IF claimant_epoch < cutover.minimum_claim_epoch OR claimant_epoch < NEW.required_compute_epoch THEN
      RAISE EXCEPTION 'compute claimant epoch % is below required epoch %',claimant_epoch,
        greatest(cutover.minimum_claim_epoch,NEW.required_compute_epoch);
    END IF;
    IF cutover.state='authoritative' AND claimant_class IS DISTINCT FROM NEW.workload_class THEN
      RAISE EXCEPTION 'compute claimant class % cannot claim % work',coalesce(claimant_class,'<unset>'),NEW.workload_class;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION finnor_os.guard_compute_job_claim() FROM PUBLIC;
CREATE TRIGGER jobs_compute_claim_fence
  BEFORE UPDATE OF status ON finnor_os.jobs
  FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_compute_job_claim();

CREATE OR REPLACE FUNCTION finnor_os.register_compute_tenant_state() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF NEW.tenant_key<>'__missing_tenant__' THEN
    INSERT INTO finnor_os.compute_tenant_claim_state(workload_class,tenant_key,tenant_id)
    VALUES(NEW.workload_class,NEW.tenant_key,NEW.tenant_id)
    ON CONFLICT(workload_class,tenant_key) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION finnor_os.register_compute_tenant_state() FROM PUBLIC;
CREATE TRIGGER jobs_compute_tenant_state
  AFTER INSERT ON finnor_os.jobs
  FOR EACH ROW EXECUTE FUNCTION finnor_os.register_compute_tenant_state();

COMMENT ON TABLE finnor_os.compute_job_type_policies IS
  'Trusted workload-class defaults, allowed classes, deterministic rules, and provenance. Payload is never classification authority.';
COMMENT ON TABLE finnor_os.compute_plane_cutover IS
  'Staged epoch fence: schema first, class services converge, then authority raises minimum_claim_epoch to exclude old claimers.';
COMMENT ON TABLE finnor_os.compute_tenant_claim_state IS
  'Durable per-class fair-claim cursor. It does not own tenant workload semantics.';
COMMENT ON TABLE finnor_os.compute_resource_policies IS
  'Only explicitly configured real shared-capacity policies. Absence means no invented global governor.';
COMMENT ON TABLE finnor_os.compute_resource_leases IS
  'Fenced, renewable shared-resource permits; acquisition is scoped to the physical invocation, never the whole job handler.';

DO $scope3_permissions$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    GRANT SELECT ON finnor_os.compute_job_type_policies TO finnor_app;
    GRANT SELECT ON finnor_os.compute_plane_cutover TO finnor_app;
    GRANT SELECT,INSERT,UPDATE ON finnor_os.compute_tenant_claim_state TO finnor_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON finnor_os.compute_control_leases TO finnor_app;
    GRANT SELECT ON finnor_os.compute_resource_policies TO finnor_app;
    GRANT SELECT,INSERT,UPDATE ON finnor_os.compute_resource_leases TO finnor_app;
    GRANT SELECT,INSERT,UPDATE ON finnor_os.compute_telemetry_publications TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.classify_compute_job() TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.guard_compute_job_claim() TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.register_compute_tenant_state() TO finnor_app;
  END IF;
END $scope3_permissions$;

-- Phase 8 runs after the four-class cutover is finalized.  The older 0130
-- functions only accepted the legacy worker role, which is intentionally
-- drained and removed at that point.  Keep the same single-release, fresh
-- heartbeat proof while selecting the runtime roles that own the current
-- compute-plane epoch.
CREATE OR REPLACE FUNCTION finnor_os.phase8_runtime_roles() RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM finnor_os.compute_plane_cutover
       WHERE singleton=true AND state='authoritative'
    ) THEN ARRAY[
      'api','compute-realtime','compute-interactive','compute-background',
      'compute-heavy','orchestrator','supplier-canary','scheduler-owner'
    ]::text[]
    ELSE ARRAY['api','worker','orchestrator','supplier-canary','scheduler-owner']::text[]
  END
$$;

CREATE OR REPLACE FUNCTION finnor_os.freeze_water_intake(
  p_expected_epoch integer,p_actor text,p_evidence jsonb DEFAULT '{}'::jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE
  current_row finnor_os.product_runtime_authority%ROWTYPE;
  required_roles text[];
  role_name text;
  release_count integer;
  expected_migration_head text;
BEGIN
  IF coalesce(btrim(p_actor),'')='' OR jsonb_typeof(p_evidence)<>'object' THEN
    RAISE EXCEPTION 'cutover actor and object evidence are required';
  END IF;
  IF NOT (p_evidence @> '{"p0P4Verified":true}'::jsonb) THEN
    RAISE EXCEPTION 'P0-P4 prerequisite verification evidence is required before intake freeze';
  END IF;
  SELECT max(name) INTO expected_migration_head FROM finnor_os._migrations;
  IF expected_migration_head IS NULL THEN
    RAISE EXCEPTION 'cutover migration provenance is unavailable';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('product_runtime_authority',0));
  SELECT * INTO current_row FROM finnor_os.product_runtime_authority
   WHERE authority_key='product' FOR UPDATE;
  IF current_row.epoch<>p_expected_epoch THEN RAISE EXCEPTION 'stale product runtime epoch'; END IF;
  IF current_row.state='water_retired' THEN RETURN current_row.epoch; END IF;
  required_roles := finnor_os.phase8_runtime_roles();
  IF current_row.state='preparing' THEN
    FOREACH role_name IN ARRAY required_roles LOOP
      IF NOT EXISTS (
        SELECT 1 FROM finnor_os.service_release_heartbeats h
         WHERE h.service=role_name
           AND h.last_beat_at>now()-interval '90 seconds'
           AND h.cutover_protocol>=current_row.minimum_cutover_protocol
           AND h.product_epoch=current_row.epoch
           AND h.migration_head=expected_migration_head
           AND h.release_sha ~ '^[0-9a-f]{40}$'
      ) OR EXISTS (
        SELECT 1 FROM finnor_os.service_release_heartbeats h
         WHERE h.service=role_name AND h.last_beat_at>now()-interval '90 seconds'
           AND (h.cutover_protocol<current_row.minimum_cutover_protocol
             OR h.product_epoch<>current_row.epoch
             OR h.migration_head<>expected_migration_head)
      ) THEN
        RAISE EXCEPTION 'mixed-fleet freeze blocked: compatible % provenance is not exclusive',role_name;
      END IF;
    END LOOP;
    SELECT count(DISTINCT release_sha)::integer INTO release_count
      FROM finnor_os.service_release_heartbeats
     WHERE service=ANY(required_roles) AND last_beat_at>now()-interval '90 seconds';
    IF release_count<>1 THEN RAISE EXCEPTION 'mixed-fleet freeze blocked: runtime roles do not share one release'; END IF;
    UPDATE finnor_os.product_runtime_authority
       SET state='water_intake_frozen',water_intake_frozen_at=now(),activated_by=p_actor,
           activation_evidence=activation_evidence||p_evidence,updated_at=now()
     WHERE authority_key='product';
  END IF;
  RETURN current_row.epoch;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.activate_private_equity_product_authority(
  p_expected_epoch integer,p_actor text,p_evidence jsonb DEFAULT '{}'::jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE
  current_row finnor_os.product_runtime_authority%ROWTYPE;
  required_roles text[];
  role_name text;
  blocker record;
  release_count integer;
  disabled_trigger_count integer;
  expected_migration_head text;
BEGIN
  IF coalesce(btrim(p_actor),'')='' OR jsonb_typeof(p_evidence)<>'object' THEN
    RAISE EXCEPTION 'cutover actor and object evidence are required';
  END IF;
  IF NOT (p_evidence @> '{"safetyCensusZero":true}'::jsonb) THEN
    RAISE EXCEPTION 'explicit zero safety-census evidence is required before retirement';
  END IF;
  SELECT max(name) INTO expected_migration_head FROM finnor_os._migrations;
  IF expected_migration_head IS NULL THEN
    RAISE EXCEPTION 'cutover migration provenance is unavailable';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('product_runtime_authority',0));
  SELECT * INTO current_row FROM finnor_os.product_runtime_authority
   WHERE authority_key='product' FOR UPDATE;
  IF current_row.epoch<>p_expected_epoch THEN RAISE EXCEPTION 'stale product runtime epoch'; END IF;
  IF current_row.state='water_retired' THEN RETURN current_row.epoch; END IF;
  IF current_row.state<>'water_intake_frozen' THEN RAISE EXCEPTION 'Water intake must be frozen before retirement'; END IF;
  required_roles := finnor_os.phase8_runtime_roles();

  FOREACH role_name IN ARRAY required_roles LOOP
    IF NOT EXISTS (
      SELECT 1 FROM finnor_os.service_release_heartbeats h
       WHERE h.service=role_name
         AND h.last_beat_at>now()-interval '90 seconds'
         AND h.cutover_protocol>=current_row.minimum_cutover_protocol
         AND h.product_epoch=current_row.epoch
         AND h.migration_head=expected_migration_head
         AND h.release_sha ~ '^[0-9a-f]{40}$'
    ) THEN
      RAISE EXCEPTION 'mixed-fleet cutover blocked: compatible % provenance is missing',role_name;
    END IF;
    IF EXISTS (
      SELECT 1 FROM finnor_os.service_release_heartbeats h
       WHERE h.service=role_name AND h.last_beat_at>now()-interval '90 seconds'
         AND (h.cutover_protocol<current_row.minimum_cutover_protocol
           OR h.product_epoch<>current_row.epoch
           OR h.migration_head<>expected_migration_head)
    ) THEN
      RAISE EXCEPTION 'mixed-fleet cutover blocked: incompatible % instance is still live',role_name;
    END IF;
  END LOOP;

  SELECT count(DISTINCT release_sha)::integer INTO release_count
    FROM finnor_os.service_release_heartbeats
   WHERE service=ANY(required_roles) AND last_beat_at>now()-interval '90 seconds';
  IF release_count<>1 THEN RAISE EXCEPTION 'mixed-fleet cutover blocked: runtime roles do not share one release'; END IF;

  FOR blocker IN SELECT * FROM finnor_os.water_retirement_blockers() LOOP
    IF blocker.blocking_count<>0 THEN
      RAISE EXCEPTION 'Water retirement safety gate blocked: %=%',blocker.category,blocker.blocking_count;
    END IF;
  END LOOP;

  UPDATE finnor_os.jobs
     SET status='quarantined',last_error='RETIRED_VERTICAL: historical Water job is non-executable',
         lease_owner=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL
   WHERE finnor_os.is_retired_water_job(type,payload) AND status='dead_letter';

  UPDATE finnor_os.vertical_definitions
     SET active=CASE key WHEN 'water' THEN false WHEN 'private_equity' THEN true ELSE active END,
         updated_at=now()
   WHERE key IN ('water','private_equity');
  UPDATE finnor_os.canonical_truth_registry SET active=false,work_attachable=false,updated_at=now()
   WHERE vertical_key='water' OR entity_type IN ('business_operation','business_operation_target');
  UPDATE finnor_os.domain_policies SET active=false
   WHERE finnor_os.is_retired_water_action(action_type)
      OR finnor_os.active_tenant_vertical(tenant_id)='water';
  UPDATE finnor_os.employee_roles SET active=false,updated_at=now()
   WHERE legacy_role IN ('dispatcher','technician')
      OR key IN ('dispatcher','technician');
  UPDATE finnor_os.employee_role_assignments a SET active=false
   WHERE EXISTS (SELECT 1 FROM finnor_os.employee_roles r WHERE r.id=a.role_id AND NOT r.active);
  UPDATE finnor_os.users SET status='suspended'
   WHERE role<>'owner' AND status='active';
  UPDATE finnor_os.tenant_settings
     SET is_dealer_zero=false,simulator_enabled=false,training_mode=false,
         workspace_config=CASE
           WHEN finnor_os.active_tenant_vertical(tenant_id)='private_equity'
             THEN finnor_os.default_private_equity_workspace_config()
           ELSE workspace_config
         END,
         updated_at=now()
   WHERE is_dealer_zero OR simulator_enabled OR training_mode;
  UPDATE finnor_os.tenant_settings
     SET workspace_config=finnor_os.default_private_equity_workspace_config(),updated_at=now()
   WHERE finnor_os.active_tenant_vertical(tenant_id)='private_equity'
     AND workspace_config IS DISTINCT FROM finnor_os.default_private_equity_workspace_config();

  SELECT finnor_os.disable_water_behavior_triggers() INTO disabled_trigger_count;

  UPDATE finnor_os.product_runtime_authority
     SET epoch=epoch+1,state='water_retired',water_retired_at=now(),activated_by=p_actor,
         activation_evidence=activation_evidence||p_evidence
           ||jsonb_build_object('waterBehaviorTriggersDropped',disabled_trigger_count),updated_at=now()
   WHERE authority_key='product';
  RETURN current_row.epoch+1;
END $$;

REVOKE ALL ON FUNCTION finnor_os.phase8_runtime_roles() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.freeze_water_intake(integer,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.activate_private_equity_product_authority(integer,text,jsonb) FROM PUBLIC;
DO $scope3_phase8_grants$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    REVOKE ALL ON FUNCTION finnor_os.phase8_runtime_roles() FROM finnor_app;
    REVOKE ALL ON FUNCTION finnor_os.freeze_water_intake(integer,text,jsonb) FROM finnor_app;
    REVOKE ALL ON FUNCTION finnor_os.activate_private_equity_product_authority(integer,text,jsonb) FROM finnor_app;
  END IF;
END $scope3_phase8_grants$;
