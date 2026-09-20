-- Scope 2: durable runtime mechanics beneath Scope-1 orchestration semantics.
--
-- Identity hierarchy (do not collapse these layers):
--   work_objective_steps          = Scope-1 semantic PlanNode ExecutionAttempt owner
--   job_delivery_attempts /       = physical runtime delivery and step-claim history
--   workflow_step_claims
--   external_operations           = logical provider-operation member
--   provider_operation_attempts   = a legally-authorized try of that logical operation
--   provider_invocations          = every physical request boundary within that try
--
-- Historical nullable fields remain unknown rather than being inferred.  In
-- particular, this migration never fabricates provider acknowledgement,
-- observation, verification, delivery, or idempotency protection.

-- Migration 0089 intended to replace the original global provider/event replay
-- constraint with a tenant-scoped key, but the original constraint's generated
-- name is inbox_events_provider_event_id_key (not the index name used there).
-- Keep the already-created tenant-scoped index and remove only the obsolete,
-- over-broad constraint.  This is a deterministic schema correction; no event
-- evidence is rewritten or backfilled.
ALTER TABLE finnor_os.inbox_events
  DROP CONSTRAINT IF EXISTS inbox_events_provider_event_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS inbox_events_provider_event_idx
  ON finnor_os.inbox_events(tenant_id,provider,event_id);

-- ---------------------------------------------------------------------------
-- Claim-safe, versioned physical job delivery.
-- ---------------------------------------------------------------------------

ALTER TABLE finnor_os.jobs
  ADD COLUMN tenant_id uuid REFERENCES finnor_os.tenants(id),
  ADD COLUMN protocol_version integer NOT NULL DEFAULT 1,
  ADD COLUMN retry_safety text NOT NULL DEFAULT 'unsafe_legacy',
  ADD COLUMN claim_token uuid,
  ADD COLUMN claim_fence bigint NOT NULL DEFAULT 0;

-- Backfill only tenant identities that are syntactically valid AND exist.  A
-- missing/invalid historical payload remains NULL; guessing would weaken isolation.
UPDATE finnor_os.jobs j
   SET tenant_id=t.id
  FROM finnor_os.tenants t
 WHERE j.tenant_id IS NULL
   AND j.payload ? 'tenantId'
   AND j.payload->>'tenantId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   AND t.id=(j.payload->>'tenantId')::uuid;

ALTER TABLE finnor_os.jobs
  ADD CONSTRAINT jobs_protocol_version_check CHECK (protocol_version BETWEEN 1 AND 1000),
  ADD CONSTRAINT jobs_retry_safety_check CHECK (retry_safety IN (
    'pure','locally_idempotent','durably_effect_guarded','reconcilable','unsafe_legacy'
  )),
  ADD CONSTRAINT jobs_claim_fence_check CHECK (claim_fence >= 0),
  ADD CONSTRAINT jobs_claim_shape_check CHECK (
    protocol_version=1
    OR (status='running' AND claim_token IS NOT NULL AND lease_owner IS NOT NULL)
    OR (status<>'running' AND claim_token IS NULL)
  );
CREATE INDEX jobs_claim_compatibility_idx
  ON finnor_os.jobs(type,protocol_version,status,run_at)
  WHERE status='queued';
CREATE INDEX jobs_tenant_status_idx
  ON finnor_os.jobs(tenant_id,status,run_at)
  WHERE tenant_id IS NOT NULL;

CREATE TABLE finnor_os.job_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES finnor_os.jobs(id),
  tenant_id uuid REFERENCES finnor_os.tenants(id),
  claim_token uuid NOT NULL UNIQUE,
  claim_fence bigint NOT NULL CHECK (claim_fence > 0),
  worker_id text NOT NULL CHECK (length(worker_id) BETWEEN 1 AND 512),
  protocol_version integer NOT NULL CHECK (protocol_version BETWEEN 1 AND 1000),
  retry_safety text NOT NULL CHECK (retry_safety IN (
    'pure','locally_idempotent','durably_effect_guarded','reconcilable','unsafe_legacy'
  )),
  outcome text NOT NULL DEFAULT 'claimed' CHECK (outcome IN (
    'claimed','running','completed','known_failed','lease_lost','reconciliation_required','dead_lettered'
  )),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  failure_kind text,
  failure_detail text,
  UNIQUE (job_id,claim_fence)
);
CREATE INDEX job_delivery_attempts_job_history_idx
  ON finnor_os.job_delivery_attempts(job_id,claim_fence DESC);
CREATE INDEX job_delivery_attempts_tenant_open_idx
  ON finnor_os.job_delivery_attempts(tenant_id,started_at,id)
  WHERE finished_at IS NULL AND tenant_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Runtime command/version contract and end-to-end step fencing.
-- ---------------------------------------------------------------------------

ALTER TABLE finnor_os.commands
  ADD COLUMN protocol_version integer NOT NULL DEFAULT 1,
  ADD COLUMN command_hash text;
ALTER TABLE finnor_os.commands
  ADD CONSTRAINT commands_protocol_version_check CHECK (protocol_version BETWEEN 1 AND 1000),
  ADD CONSTRAINT commands_command_hash_check CHECK (
    command_hash IS NULL OR command_hash ~ '^sha256:[0-9a-f]{64}$'
  );

ALTER TABLE finnor_os.workflow_runs
  ADD COLUMN protocol_version integer NOT NULL DEFAULT 1;
ALTER TABLE finnor_os.workflow_runs
  ADD CONSTRAINT workflow_runs_protocol_version_check CHECK (protocol_version BETWEEN 1 AND 1000);

ALTER TABLE finnor_os.workflow_steps
  ADD COLUMN protocol_version integer NOT NULL DEFAULT 1,
  ADD COLUMN claim_token uuid,
  ADD COLUMN claim_fence bigint NOT NULL DEFAULT 0,
  ADD COLUMN claim_owner text,
  ADD COLUMN lease_heartbeat_at timestamptz,
  ADD COLUMN causal_ready_at timestamptz,
  ADD COLUMN execution_eligible_at timestamptz,
  ADD COLUMN eligibility_evidence jsonb;
ALTER TABLE finnor_os.workflow_steps
  ADD CONSTRAINT workflow_steps_protocol_version_check CHECK (protocol_version BETWEEN 1 AND 1000),
  ADD CONSTRAINT workflow_steps_claim_fence_check CHECK (claim_fence >= 0),
  ADD CONSTRAINT workflow_steps_claim_shape_v2_check CHECK (
    protocol_version=1
    OR (status='leased' AND claim_token IS NOT NULL AND claim_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL AND lease_heartbeat_at IS NOT NULL)
    OR (status<>'leased' AND claim_token IS NULL AND claim_owner IS NULL)
  ),
  ADD CONSTRAINT workflow_steps_readiness_order_check CHECK (
    execution_eligible_at IS NULL OR (causal_ready_at IS NOT NULL AND execution_eligible_at >= causal_ready_at)
  ),
  ADD CONSTRAINT workflow_steps_eligibility_evidence_check CHECK (
    eligibility_evidence IS NULL OR (
      jsonb_typeof(eligibility_evidence)='object'
      AND octet_length(eligibility_evidence::text)<=65536
    )
  );
CREATE INDEX workflow_steps_claim_fence_idx
  ON finnor_os.workflow_steps(tenant_id,id,dispatch_generation,claim_fence)
  WHERE status='leased';

CREATE TABLE finnor_os.workflow_step_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  workflow_step_id uuid NOT NULL REFERENCES finnor_os.workflow_steps(id),
  job_delivery_attempt_id uuid REFERENCES finnor_os.job_delivery_attempts(id),
  claim_token uuid NOT NULL UNIQUE,
  claim_fence bigint NOT NULL CHECK (claim_fence > 0),
  dispatch_generation integer NOT NULL CHECK (dispatch_generation >= 0),
  protocol_version integer NOT NULL CHECK (protocol_version BETWEEN 1 AND 1000),
  worker_id text NOT NULL CHECK (length(worker_id) BETWEEN 1 AND 512),
  outcome text NOT NULL DEFAULT 'claimed' CHECK (outcome IN (
    'claimed','attempted','completed','known_failed','lease_lost','superseded','awaiting_observation','reconciliation_required'
  )),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempted_at timestamptz,
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE (workflow_step_id,claim_fence),
  UNIQUE (tenant_id,id)
);
CREATE INDEX workflow_step_claims_step_history_idx
  ON finnor_os.workflow_step_claims(tenant_id,workflow_step_id,claim_fence DESC);
CREATE INDEX workflow_step_claims_open_idx
  ON finnor_os.workflow_step_claims(tenant_id,heartbeat_at,id)
  WHERE finished_at IS NULL;

-- ---------------------------------------------------------------------------
-- Logical provider-operation members and visible physical invocations.
-- ---------------------------------------------------------------------------

ALTER TABLE finnor_os.external_operations ADD COLUMN id uuid;
UPDATE finnor_os.external_operations SET id=gen_random_uuid() WHERE id IS NULL;
ALTER TABLE finnor_os.external_operations DROP CONSTRAINT external_operations_pkey;
ALTER TABLE finnor_os.external_operations
  ALTER COLUMN id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN domain_action_id DROP NOT NULL,
  ADD COLUMN owner_type text NOT NULL DEFAULT 'domain_action',
  ADD COLUMN owner_key text,
  ADD COLUMN protocol_version integer NOT NULL DEFAULT 1,
  ADD COLUMN target_key text,
  ADD COLUMN execution_state text NOT NULL DEFAULT 'claimed',
  ADD COLUMN retry_safety text NOT NULL DEFAULT 'unknown',
  ADD COLUMN provider_idempotency_mode text NOT NULL DEFAULT 'unknown',
  ADD COLUMN provider_idempotency_key text,
  ADD COLUMN provider_idempotency_scope text,
  ADD COLUMN provider_idempotency_expires_at timestamptz,
  ADD COLUMN verification_mode text NOT NULL DEFAULT 'readback',
  ADD COLUMN history_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN version integer NOT NULL DEFAULT 1;
UPDATE finnor_os.external_operations
   SET owner_key=domain_action_id::text
 WHERE owner_key IS NULL;
ALTER TABLE finnor_os.external_operations
  ALTER COLUMN owner_key SET NOT NULL,
  ADD CONSTRAINT external_operations_pkey PRIMARY KEY (id);
ALTER TABLE finnor_os.external_operations
  ADD CONSTRAINT external_operations_tenant_id_id_key UNIQUE (tenant_id,id),
  ADD CONSTRAINT external_operations_owner_key UNIQUE (tenant_id,owner_type,owner_key,operation_key),
  ADD CONSTRAINT external_operations_owner_type_check CHECK (owner_type IN (
    'domain_action','integration_subscription','computer_run','artifact_operation','system_job'
  )),
  ADD CONSTRAINT external_operations_owner_shape_check CHECK (
    (owner_type='domain_action' AND domain_action_id IS NOT NULL AND owner_key=domain_action_id::text)
    OR (owner_type<>'domain_action' AND domain_action_id IS NULL)
  ),
  ADD CONSTRAINT external_operations_protocol_version_check CHECK (protocol_version BETWEEN 1 AND 1000),
  ADD CONSTRAINT external_operations_execution_state_check CHECK (execution_state IN (
    'claimed','provider_in_flight','provider_acknowledged','awaiting_observation',
    'verified','divergent','known_failed','unknown_outcome','reconciliation_required',
    'reconciled','compensated'
  )),
  ADD CONSTRAINT external_operations_retry_safety_check CHECK (retry_safety IN (
    'first_invocation_only','provider_idempotent','readback_required','repeatable','prohibited','unknown'
  )),
  ADD CONSTRAINT external_operations_idempotency_mode_check CHECK (provider_idempotency_mode IN (
    'provider_key','readback','inherently_idempotent','none','unknown'
  )),
  ADD CONSTRAINT external_operations_idempotency_shape_check CHECK (
    (provider_idempotency_mode='provider_key' AND provider_idempotency_key IS NOT NULL)
    OR provider_idempotency_mode<>'provider_key'
  ),
  ADD CONSTRAINT external_operations_verification_mode_check CHECK (
    verification_mode IN ('acknowledgement','readback','webhook_or_readback','none')
  ),
  ADD CONSTRAINT external_operations_version_check CHECK (version > 0);
CREATE INDEX external_operations_effect_members_idx
  ON finnor_os.external_operations(tenant_id,business_effect_id,execution_state,operation_key)
  WHERE business_effect_id IS NOT NULL;
CREATE INDEX external_operations_reconciliation_idx
  ON finnor_os.external_operations(tenant_id,execution_state,updated_at,id)
  WHERE execution_state IN ('unknown_outcome','reconciliation_required','divergent');

COMMENT ON TABLE finnor_os.integration_operations IS
  'Aggregate workflow-step effect-runtime envelope. It is not a logical provider call and may own multiple external_operations members.';
COMMENT ON TABLE finnor_os.external_operations IS
  'One logical provider operation. Scope-1 effects use owner_type=domain_action; tenant runtime substrates may use an explicit non-semantic owner without fabricating a DomainAction. Identity survives physical delivery, retry, restart, and refactor.';

CREATE TABLE finnor_os.provider_operation_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  external_operation_id uuid NOT NULL,
  workflow_step_claim_id uuid,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  protocol_version integer NOT NULL CHECK (protocol_version BETWEEN 1 AND 1000),
  authorization_basis text NOT NULL CHECK (authorization_basis IN (
    'initial','provider_idempotency','verified_absent','definite_pre_dispatch_failure','definite_rejection','inherently_repeatable','operator_resolution'
  )),
  status text NOT NULL DEFAULT 'claimed' CHECK (status IN (
    'claimed','provider_in_flight','provider_acknowledged','awaiting_observation','verified',
    'divergent','known_failed','unknown_outcome','reconciliation_required','reconciled','compensated'
  )),
  claim_token uuid NOT NULL UNIQUE,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  outcome_detail jsonb,
  UNIQUE (external_operation_id,ordinal),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,external_operation_id)
    REFERENCES finnor_os.external_operations(tenant_id,id),
  FOREIGN KEY (tenant_id,workflow_step_claim_id)
    REFERENCES finnor_os.workflow_step_claims(tenant_id,id)
);
CREATE INDEX provider_operation_attempts_operation_history_idx
  ON finnor_os.provider_operation_attempts(tenant_id,external_operation_id,ordinal);

CREATE TABLE finnor_os.provider_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  provider_operation_attempt_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 160),
  integration_id uuid,
  transport_layer text NOT NULL CHECK (transport_layer IN (
    'wrapped_call','sdk','http_client','provider_adapter','fake_provider'
  )),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  provider_idempotency_key text,
  provider_idempotency_scope text,
  provider_idempotency_expires_at timestamptz,
  outcome text NOT NULL DEFAULT 'prepared' CHECK (outcome IN (
    'prepared','request_may_have_left','provider_acknowledged','definite_rejection',
    'definite_pre_dispatch_failure','unknown_outcome'
  )),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_may_have_left_at timestamptz,
  provider_acknowledged_at timestamptz,
  finished_at timestamptz,
  provider_request_id text,
  failure_kind text,
  receipt jsonb,
  UNIQUE (provider_operation_attempt_id,ordinal),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,provider_operation_attempt_id)
    REFERENCES finnor_os.provider_operation_attempts(tenant_id,id)
);
CREATE INDEX provider_invocations_attempt_history_idx
  ON finnor_os.provider_invocations(tenant_id,provider_operation_attempt_id,ordinal);
CREATE INDEX provider_invocations_possible_effect_idx
  ON finnor_os.provider_invocations(tenant_id,started_at,id)
  WHERE request_may_have_left_at IS NOT NULL
    AND outcome IN ('request_may_have_left','unknown_outcome');

-- Security-invoker view: one BusinessEffect can have zero, one, or many member
-- operations.  Partial verification/uncertainty is visible instead of collapsed.
CREATE VIEW finnor_os.business_effect_operation_summary WITH (security_invoker=true) AS
SELECT tenant_id,business_effect_id,
       count(*)::integer AS member_count,
       count(*) FILTER (WHERE execution_state='verified'
         OR (execution_state='reconciled' AND response->>'reconciliationOutcome'='happened_as_intended'))::integer AS verified_count,
       count(*) FILTER (WHERE execution_state='known_failed'
         OR (execution_state='reconciled' AND response->>'reconciliationOutcome'='definitely_did_not_happen'))::integer AS known_failed_count,
       count(*) FILTER (WHERE execution_state IN ('unknown_outcome','reconciliation_required'))::integer AS uncertain_count,
       count(*) FILTER (WHERE execution_state='divergent')::integer AS divergent_count,
       count(*) FILTER (WHERE execution_state='compensated')::integer AS compensated_count,
       count(*) FILTER (WHERE execution_state IN ('claimed','provider_in_flight','provider_acknowledged','awaiting_observation'))::integer AS incomplete_count
  FROM finnor_os.external_operations
 WHERE business_effect_id IS NOT NULL
 GROUP BY tenant_id,business_effect_id;

-- ---------------------------------------------------------------------------
-- Governed consequential operator controls and evidence-bearing reconciliation.
-- Scope 1 continues to own REPLAN / ESCALATE / CANCEL RecoveryDecision semantics.
-- ---------------------------------------------------------------------------

ALTER TABLE finnor_os.reconciliation_cases
  ADD COLUMN related_external_operation_id uuid,
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN resolution_outcome text,
  ADD COLUMN resolution_evidence jsonb,
  ADD COLUMN resolved_by text,
  ADD COLUMN resolution_provider text,
  ADD COLUMN resolution_integration_id uuid;
ALTER TABLE finnor_os.reconciliation_cases
  ADD CONSTRAINT reconciliation_cases_version_check CHECK (version > 0),
  ADD CONSTRAINT reconciliation_cases_operation_fkey FOREIGN KEY (tenant_id,related_external_operation_id)
    REFERENCES finnor_os.external_operations(tenant_id,id),
  ADD CONSTRAINT reconciliation_cases_resolution_outcome_check CHECK (
    resolution_outcome IS NULL OR resolution_outcome IN (
      'happened_as_intended','definitely_did_not_happen','happened_differently',
      'still_unknowable','legally_compensatable'
    )
  ),
  ADD CONSTRAINT reconciliation_cases_resolution_shape_check CHECK (
    (status='open' AND resolved_at IS NULL AND resolution_outcome IS NULL AND resolved_by IS NULL)
    OR (status='resolved' AND resolved_at IS NOT NULL AND resolution_outcome IS NOT NULL
      AND resolution_evidence IS NOT NULL AND resolved_by IS NOT NULL)
    OR (status='resolved' AND resolution_outcome IS NULL AND resolution_evidence IS NULL
      AND resolved_by IS NULL)
  );
CREATE INDEX reconciliation_cases_operation_idx
  ON finnor_os.reconciliation_cases(tenant_id,related_external_operation_id,status)
  WHERE related_external_operation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION finnor_os.guard_scope2_reconciliation_resolution() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF OLD.status='resolved' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'resolved reconciliation evidence is immutable';
  END IF;
  IF OLD.status='open' AND NEW.status='resolved' THEN
    IF NEW.resolved_at IS NULL OR NEW.resolution_outcome IS NULL
      OR NEW.resolution_evidence IS NULL OR NEW.resolved_by IS NULL
      OR NEW.version<>OLD.version+1 THEN
      RAISE EXCEPTION 'Scope-2 reconciliation resolution requires evidence, actor, outcome, and exact version increment';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_cases_scope2_resolution
  BEFORE UPDATE ON finnor_os.reconciliation_cases
  FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_scope2_reconciliation_resolution();

ALTER TABLE finnor_os.compensation_cases
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN initiated_by text,
  ADD COLUMN authority_decision_id uuid REFERENCES finnor_os.authority_decisions(id);
ALTER TABLE finnor_os.compensation_cases
  ADD CONSTRAINT compensation_cases_version_check CHECK (version > 0);

ALTER TABLE finnor_os.dead_letters ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE finnor_os.dead_letters
  ADD CONSTRAINT dead_letters_version_check CHECK (version > 0);

CREATE TABLE finnor_os.runtime_operator_controls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  control_key text NOT NULL,
  control_type text NOT NULL CHECK (control_type IN (
    'step_redrive','dlq_replay','dlq_discard','reconciliation_resolution','compensation_initiation'
  )),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 512),
  authority_decision_id uuid,
  target_type text NOT NULL CHECK (target_type IN (
    'workflow_step','dead_letter','reconciliation_case','compensation_case'
  )),
  target_id uuid NOT NULL,
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  observed_fence bigint,
  request_hash text NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 4000),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=131072),
  outcome text NOT NULL CHECK (outcome IN ('applied','conflict','rejected','blocked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,control_key),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,authority_decision_id)
    REFERENCES finnor_os.authority_decisions(tenant_id,id)
);
CREATE INDEX runtime_operator_controls_target_idx
  ON finnor_os.runtime_operator_controls(tenant_id,target_type,target_id,created_at,id);

CREATE OR REPLACE FUNCTION finnor_os.guard_runtime_operator_control() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'runtime operator controls are append-only audit evidence'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_operator_controls_append_only
  BEFORE UPDATE OR DELETE ON finnor_os.runtime_operator_controls
  FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_runtime_operator_control();

-- ---------------------------------------------------------------------------
-- Dormant outbox retirement.  The deployment is blocked if any persisted
-- obligation remains.  Historical rows are preserved exactly as recorded.
-- ---------------------------------------------------------------------------

CREATE TABLE finnor_os.runtime_substrate_retirements (
  substrate text PRIMARY KEY,
  retired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_by text NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object')
);

DO $scope2_outbox_guard$
DECLARE unresolved_events bigint; unresolved_dlq bigint; unresolved_cases bigint;
BEGIN
  SELECT count(*) INTO unresolved_events FROM finnor_os.outbox_events
   WHERE status IN ('pending','delivering','unknown','failed');
  SELECT count(*) INTO unresolved_dlq FROM finnor_os.dead_letters
   WHERE related_outbox_event_id IS NOT NULL AND status='open';
  SELECT count(*) INTO unresolved_cases FROM finnor_os.reconciliation_cases
   WHERE related_outbox_event_id IS NOT NULL AND status='open';
  IF unresolved_events<>0 OR unresolved_dlq<>0 OR unresolved_cases<>0 THEN
    RAISE EXCEPTION 'Scope-2 outbox retirement blocked: % unresolved events, % open DLQ rows, % open reconciliation cases',
      unresolved_events,unresolved_dlq,unresolved_cases;
  END IF;
  INSERT INTO finnor_os.runtime_substrate_retirements(substrate,retired_by,evidence)
  VALUES ('outbox','migration:0137_scope2_durable_runtime',jsonb_build_object(
    'unresolvedEvents',unresolved_events,'openDeadLetters',unresolved_dlq,
    'openReconciliationCases',unresolved_cases,'inspection','transactional deployment guard'
  ));
END $scope2_outbox_guard$;

CREATE OR REPLACE FUNCTION finnor_os.reject_retired_outbox_production() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  RAISE EXCEPTION 'outbox substrate is retired; use the canonical job/event/effect owner';
END $$;
CREATE TRIGGER outbox_events_retired_no_insert
  BEFORE INSERT ON finnor_os.outbox_events
  FOR EACH ROW EXECUTE FUNCTION finnor_os.reject_retired_outbox_production();

UPDATE finnor_os.jobs
   SET status='quarantined',
       last_error='Scope-2 retired dormant outbox relay after zero-obligation deployment guard',
       started_at=NULL,lease_owner=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL,claim_token=NULL
 WHERE type='relay_outbox_events' AND status IN ('queued','running');

-- The following handlers issued provider mutations without the canonical logical
-- operation -> runtime attempt -> physical invocation chain. They are retired, not
-- relabelled safe. Abort the deployment if any unresolved durable obligation exists;
-- an operator must inspect and disposition it under the old release first.
DO $scope2_legacy_provider_job_guard$
DECLARE unresolved_jobs bigint; open_deliveries bigint;
BEGIN
  SELECT count(*) INTO unresolved_jobs FROM finnor_os.jobs
   WHERE type=ANY(ARRAY[
     'voice_confirm_request','voice_notify_failure','send_push_notification',
     'send_resend_email','backup_db'
   ]::text[])
     AND status IN ('queued','running','failed','dead_letter','quarantined');
  SELECT count(*) INTO open_deliveries
    FROM finnor_os.job_delivery_attempts delivery
    JOIN finnor_os.jobs job ON job.id=delivery.job_id
   WHERE job.type=ANY(ARRAY[
     'voice_confirm_request','voice_notify_failure','send_push_notification',
     'send_resend_email','backup_db'
   ]::text[])
     AND delivery.finished_at IS NULL;
  IF unresolved_jobs<>0 OR open_deliveries<>0 THEN
    RAISE EXCEPTION 'Scope-2 legacy provider-job retirement blocked: % unresolved jobs, % open delivery attempts',
      unresolved_jobs,open_deliveries;
  END IF;
  INSERT INTO finnor_os.runtime_substrate_retirements(substrate,retired_by,evidence)
  VALUES ('untracked_provider_jobs','migration:0137_scope2_durable_runtime',jsonb_build_object(
    'jobTypes',ARRAY[
      'voice_confirm_request','voice_notify_failure','send_push_notification',
      'send_resend_email','backup_db'
    ],
    'unresolvedJobs',unresolved_jobs,'openDeliveryAttempts',open_deliveries,
    'inspection','transactional deployment guard',
    'replacement','durable attention/Sentry for notifications; repository-controlled backup remains manual until a global operation ledger exists'
  ));
END $scope2_legacy_provider_job_guard$;

CREATE OR REPLACE FUNCTION finnor_os.reject_retired_provider_job() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF NEW.type=ANY(ARRAY[
    'voice_confirm_request','voice_notify_failure','send_push_notification',
    'send_resend_email','backup_db'
  ]::text[]) THEN
    RAISE EXCEPTION 'provider job % is retired; use a canonical Effect Protocol operation',NEW.type;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_retired_provider_job_no_write
  BEFORE INSERT OR UPDATE OF type ON finnor_os.jobs
  FOR EACH ROW EXECUTE FUNCTION finnor_os.reject_retired_provider_job();

-- ---------------------------------------------------------------------------
-- Tenant isolation and least privilege for new tenant truth.
-- ---------------------------------------------------------------------------

DO $scope2_rls$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workflow_step_claims','provider_operation_attempts','provider_invocations',
    'runtime_operator_controls'
  ] LOOP
    EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON finnor_os.%I USING (tenant_id=finnor_os.request_tenant_id()) WITH CHECK (tenant_id=finnor_os.request_tenant_id())',t
    );
  END LOOP;
END $scope2_rls$;

DO $scope2_permissions$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    GRANT SELECT,INSERT,UPDATE ON finnor_os.workflow_step_claims TO finnor_app;
    GRANT SELECT,INSERT,UPDATE ON finnor_os.provider_operation_attempts TO finnor_app;
    GRANT SELECT,INSERT,UPDATE ON finnor_os.provider_invocations TO finnor_app;
    GRANT SELECT,INSERT ON finnor_os.runtime_operator_controls TO finnor_app;
    REVOKE UPDATE,DELETE ON finnor_os.runtime_operator_controls FROM finnor_app;
    GRANT SELECT ON finnor_os.business_effect_operation_summary TO finnor_app;
    GRANT SELECT ON finnor_os.runtime_substrate_retirements TO finnor_app;
    GRANT SELECT,INSERT,UPDATE ON finnor_os.job_delivery_attempts TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.guard_runtime_operator_control() TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.guard_scope2_reconciliation_resolution() TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.reject_retired_outbox_production() TO finnor_app;
  END IF;
END $scope2_permissions$;

COMMENT ON TABLE finnor_os.job_delivery_attempts IS
  'Physical queue delivery claims; never a Scope-1 semantic ExecutionAttempt.';
COMMENT ON TABLE finnor_os.workflow_step_claims IS
  'Runtime execution claims fenced by token, fence, dispatch generation, and protocol; never a Scope-1 semantic ExecutionAttempt.';
COMMENT ON TABLE finnor_os.provider_operation_attempts IS
  'Legally-authorized tries of one logical provider operation; does not replace Scope-1 PlanNode attempt identity.';
COMMENT ON TABLE finnor_os.provider_invocations IS
  'Every physical consequential request boundary, including wrapped-call retries; records possible request egress without claiming external truth.';
COMMENT ON TABLE finnor_os.runtime_operator_controls IS
  'Tenant-scoped append-only evidence for consequential runtime operator controls; higher-level recovery decisions remain Scope-1 owned.';
COMMENT ON TABLE finnor_os.runtime_substrate_retirements IS
  'Deployment-time proof that a dormant substrate was retired only after persisted obligations were inspected and found empty.';
