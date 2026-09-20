-- Scope 1: one persisted orchestration protocol over the existing P6 PlanGraph,
-- P7 workforce claim, Objective, Authority, DomainAction, BusinessEffect, runtime,
-- observation, reconciliation, and CompletionProof owners. Historical rows are
-- deliberately left nullable where their exact attempt/revision truth is not
-- derivable; this migration never manufactures verification or recovery history.

ALTER TABLE finnor_os.work_plan_revisions
  ADD COLUMN compiler_version text,
  ADD COLUMN revision_transition jsonb;
ALTER TABLE finnor_os.work_plan_revisions
  ADD CONSTRAINT work_plan_revisions_compiler_version_check CHECK (
    compiler_version IS NULL OR length(compiler_version) BETWEEN 1 AND 120
  ),
  ADD CONSTRAINT work_plan_revisions_transition_check CHECK (
    revision_transition IS NULL OR (
      jsonb_typeof(revision_transition)='object'
      AND revision_transition->>'version'='1'
      AND octet_length(revision_transition::text)<=131072
    )
  );

ALTER TABLE finnor_os.work_objective_loops
  ADD COLUMN max_parallel_nodes integer NOT NULL DEFAULT 4,
  ADD COLUMN node_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN max_node_attempts integer NOT NULL DEFAULT 100,
  ADD COLUMN wait_count integer NOT NULL DEFAULT 0,
  ADD COLUMN max_waits integer NOT NULL DEFAULT 12,
  ADD COLUMN max_estimated_cost_micros bigint NOT NULL DEFAULT 5000000,
  ADD COLUMN reserved_estimated_cost_micros bigint NOT NULL DEFAULT 0;
ALTER TABLE finnor_os.work_objective_loops
  ADD CONSTRAINT work_objective_loops_parallel_check CHECK (max_parallel_nodes BETWEEN 1 AND 32),
  ADD CONSTRAINT work_objective_loops_attempt_budget_check CHECK (
    node_attempt_count BETWEEN 0 AND max_node_attempts AND max_node_attempts BETWEEN 1 AND 10000
  ),
  ADD CONSTRAINT work_objective_loops_wait_budget_check CHECK (
    wait_count BETWEEN 0 AND max_waits AND max_waits BETWEEN 0 AND 10000
  ),
  ADD CONSTRAINT work_objective_loops_cost_budget_check CHECK (
    max_estimated_cost_micros BETWEEN 0 AND 9007199254740991
    AND reserved_estimated_cost_micros BETWEEN 0 AND max_estimated_cost_micros
  );

ALTER TABLE finnor_os.work_objective_steps
  ADD COLUMN objective_revision integer,
  ADD COLUMN attempt_number integer,
  ADD COLUMN execution_role text,
  ADD COLUMN execution_state text,
  ADD COLUMN claim_owner text,
  ADD COLUMN claim_until timestamptz,
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN recovery_parent_step_id uuid,
  ADD COLUMN verification_result jsonb,
  ADD COLUMN resource_keys text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN budget_reservation_kind text,
  ADD COLUMN estimated_cost_reservation_micros bigint NOT NULL DEFAULT 0,
  ADD COLUMN budget_reserved_at timestamptz;
ALTER TABLE finnor_os.work_objective_steps ALTER COLUMN attempt_number SET DEFAULT 1;
ALTER TABLE finnor_os.work_objective_steps
  ADD CONSTRAINT work_objective_steps_objective_revision_check CHECK (objective_revision IS NULL OR objective_revision > 0),
  ADD CONSTRAINT work_objective_steps_attempt_number_check CHECK (attempt_number IS NULL OR attempt_number BETWEEN 1 AND 100),
  ADD CONSTRAINT work_objective_steps_execution_role_check CHECK (execution_role IS NULL OR execution_role IN ('controller','node')),
  ADD CONSTRAINT work_objective_steps_execution_state_check CHECK (execution_state IS NULL OR execution_state IN (
    'scheduled','claimed','running','waiting','completed','failed','reconciliation_required','cancelled','superseded'
  )),
  ADD CONSTRAINT work_objective_steps_claim_shape_check CHECK ((claim_owner IS NULL)=(claim_until IS NULL)),
  ADD CONSTRAINT work_objective_steps_claim_state_check CHECK (
    execution_role IS DISTINCT FROM 'node' OR execution_state NOT IN ('claimed','running') OR claim_owner IS NOT NULL
  ),
  ADD CONSTRAINT work_objective_steps_recovery_parent_fkey FOREIGN KEY (tenant_id,recovery_parent_step_id)
    REFERENCES finnor_os.work_objective_steps(tenant_id,id),
  ADD CONSTRAINT work_objective_steps_verification_result_check CHECK (verification_result IS NULL OR (
    jsonb_typeof(verification_result)='object' AND verification_result->>'version'='1'
    AND verification_result->>'state' IN ('verified','divergent','inconclusive')
    AND octet_length(verification_result::text)<=65536
  )),
  ADD CONSTRAINT work_objective_steps_resource_keys_check CHECK (cardinality(resource_keys)<=64),
  ADD CONSTRAINT work_objective_steps_budget_reservation_check CHECK (
    (budget_reservation_kind IS NULL AND budget_reserved_at IS NULL AND estimated_cost_reservation_micros=0)
    OR (budget_reservation_kind IN ('query','action','wait','check') AND budget_reserved_at IS NOT NULL
      AND estimated_cost_reservation_micros BETWEEN 0 AND 9007199254740991)
  );
CREATE UNIQUE INDEX work_objective_steps_plan_node_attempt_idx
  ON finnor_os.work_objective_steps(plan_revision_id,plan_node_id,attempt_number)
  WHERE plan_revision_id IS NOT NULL AND attempt_number IS NOT NULL;
CREATE INDEX work_objective_steps_claimable_idx
  ON finnor_os.work_objective_steps(tenant_id,plan_revision_id,execution_state,claim_until,step_number,id)
  WHERE execution_role='node' AND completed_at IS NULL;
CREATE INDEX work_objective_steps_loop_revision_idx
  ON finnor_os.work_objective_steps(tenant_id,objective_loop_id,objective_revision,execution_state,step_number,id);

ALTER TABLE finnor_os.workforce_assignments
  ADD COLUMN objective_revision integer,
  ADD COLUMN node_attempt integer;
ALTER TABLE finnor_os.workforce_assignments
  ADD CONSTRAINT workforce_assignments_objective_revision_check CHECK (objective_revision IS NULL OR objective_revision > 0),
  ADD CONSTRAINT workforce_assignments_node_attempt_check CHECK (node_attempt IS NULL OR node_attempt BETWEEN 1 AND 100);
CREATE INDEX workforce_assignments_node_attempt_idx
  ON finnor_os.workforce_assignments(tenant_id,plan_revision_id,plan_node_id,node_attempt);

-- A physical workforce lease may only point at its exact logical attempt.  The
-- nullable branch exists solely for pre-Scope-1 history; new kernel attempts set
-- both generation fields and are rejected if either side of the identity drifts.
CREATE OR REPLACE FUNCTION finnor_os.assert_scope1_workforce_attempt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE
  step_loop uuid; step_work uuid; step_plan uuid; step_node text;
  step_revision integer; step_attempt integer; step_role text;
  step_completed timestamptz; loop_revision integer;
BEGIN
  IF (NEW.objective_revision IS NULL) IS DISTINCT FROM (NEW.node_attempt IS NULL) THEN
    RAISE EXCEPTION 'WorkforceAssignment generation identity must be wholly historical or wholly exact';
  END IF;
  IF NEW.objective_step_id IS NULL THEN
    IF NEW.objective_revision IS NOT NULL THEN
      RAISE EXCEPTION 'WorkforceAssignment generation identity requires an ObjectiveStep';
    END IF;
    RETURN NEW;
  END IF;
  SELECT objective_loop_id,work_id,plan_revision_id,plan_node_id,objective_revision,
         attempt_number,execution_role,completed_at
    INTO step_loop,step_work,step_plan,step_node,step_revision,
         step_attempt,step_role,step_completed
    FROM finnor_os.work_objective_steps
    WHERE tenant_id=NEW.tenant_id AND id=NEW.objective_step_id;
  IF step_loop IS DISTINCT FROM NEW.objective_loop_id OR step_work IS DISTINCT FROM NEW.work_id
    OR step_plan IS DISTINCT FROM NEW.plan_revision_id OR step_node IS DISTINCT FROM NEW.plan_node_id THEN
    RAISE EXCEPTION 'WorkforceAssignment crosses its ObjectiveStep/PlanNode boundary';
  END IF;
  IF NEW.objective_revision IS NOT NULL THEN
    SELECT revision INTO loop_revision FROM finnor_os.work_objective_loops
      WHERE tenant_id=NEW.tenant_id AND id=NEW.objective_loop_id AND work_id=NEW.work_id;
    IF step_revision IS DISTINCT FROM NEW.objective_revision
      OR step_attempt IS DISTINCT FROM NEW.node_attempt
      OR loop_revision IS DISTINCT FROM NEW.objective_revision
      OR step_role IS DISTINCT FROM 'node' OR step_completed IS NOT NULL THEN
      RAISE EXCEPTION 'WorkforceAssignment does not match the exact live logical attempt';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workforce_assignments_scope1_attempt
  BEFORE INSERT OR UPDATE OF objective_revision,node_attempt,objective_step_id,
    objective_loop_id,plan_revision_id,plan_node_id,work_id
  ON finnor_os.workforce_assignments FOR EACH ROW
  EXECUTE FUNCTION finnor_os.assert_scope1_workforce_attempt();

ALTER TABLE finnor_os.work_event_waits
  ADD COLUMN plan_revision_id uuid,
  ADD COLUMN plan_node_id text,
  ADD COLUMN objective_revision integer;
ALTER TABLE finnor_os.work_event_waits
  ADD CONSTRAINT work_event_waits_plan_link_pair CHECK ((plan_revision_id IS NULL)=(plan_node_id IS NULL)),
  ADD CONSTRAINT work_event_waits_plan_revision_fkey FOREIGN KEY (tenant_id,work_id,plan_revision_id)
    REFERENCES finnor_os.work_plan_revisions(tenant_id,work_id,id),
  ADD CONSTRAINT work_event_waits_objective_revision_check CHECK (objective_revision IS NULL OR objective_revision > 0);
CREATE INDEX work_event_waits_plan_node_idx
  ON finnor_os.work_event_waits(tenant_id,plan_revision_id,plan_node_id,status);

CREATE OR REPLACE FUNCTION finnor_os.assert_scope1_wait_generation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE step_plan uuid; step_node text; step_revision integer; plan_status text;
BEGIN
  IF NEW.plan_revision_id IS NULL THEN RETURN NEW; END IF;
  SELECT plan_revision_id,plan_node_id,objective_revision INTO step_plan,step_node,step_revision
    FROM finnor_os.work_objective_steps
    WHERE tenant_id=NEW.tenant_id AND id=NEW.objective_step_id;
  SELECT status INTO plan_status FROM finnor_os.work_plan_revisions
    WHERE tenant_id=NEW.tenant_id AND work_id=NEW.work_id AND id=NEW.plan_revision_id;
  IF step_plan IS DISTINCT FROM NEW.plan_revision_id OR step_node IS DISTINCT FROM NEW.plan_node_id
    OR step_revision IS DISTINCT FROM NEW.objective_revision OR plan_status IS NULL THEN
    RAISE EXCEPTION 'WorkEventWait generation does not match its exact ObjectiveStep/PlanRevision';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER work_event_waits_scope1_generation
  BEFORE INSERT OR UPDATE OF plan_revision_id,plan_node_id,objective_revision,objective_step_id
  ON finnor_os.work_event_waits FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_scope1_wait_generation();

CREATE TABLE finnor_os.work_recovery_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  work_id uuid NOT NULL,
  objective_loop_id uuid NOT NULL,
  objective_revision integer NOT NULL CHECK (objective_revision > 0),
  plan_revision_id uuid NOT NULL,
  plan_node_id text NOT NULL CHECK (length(plan_node_id) BETWEEN 1 AND 160),
  objective_step_id uuid,
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 100),
  recovery_parent_step_id uuid,
  authority_decision_id uuid,
  domain_action_id uuid,
  business_effect_id uuid,
  verification_result jsonb,
  decision text NOT NULL CHECK (decision IN (
    'retry','wait','reconcile','replan','escalate','compensate','cancel','terminal_failure','continue'
  )),
  cause text NOT NULL CHECK (cause IN (
    'failure','stale','timeout','divergence','unknown_outcome','budget','deadline','cancellation','observation'
  )),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 4000),
  context jsonb NOT NULL CHECK (jsonb_typeof(context)='object' AND octet_length(context::text)<=131072),
  decision_key text NOT NULL CHECK (decision_key ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,decision_key),
  FOREIGN KEY (tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
  FOREIGN KEY (tenant_id,work_id,plan_revision_id) REFERENCES finnor_os.work_plan_revisions(tenant_id,work_id,id),
  FOREIGN KEY (tenant_id,objective_loop_id) REFERENCES finnor_os.work_objective_loops(tenant_id,id),
  FOREIGN KEY (tenant_id,objective_step_id) REFERENCES finnor_os.work_objective_steps(tenant_id,id),
  FOREIGN KEY (tenant_id,recovery_parent_step_id) REFERENCES finnor_os.work_objective_steps(tenant_id,id),
  FOREIGN KEY (tenant_id,authority_decision_id) REFERENCES finnor_os.authority_decisions(tenant_id,id),
  FOREIGN KEY (tenant_id,domain_action_id) REFERENCES finnor_os.domain_actions(tenant_id,id),
  FOREIGN KEY (tenant_id,business_effect_id) REFERENCES finnor_os.business_effects(tenant_id,id)
);
CREATE INDEX work_recovery_decisions_work_idx
  ON finnor_os.work_recovery_decisions(tenant_id,work_id,created_at,id);
CREATE INDEX work_recovery_decisions_attempt_idx
  ON finnor_os.work_recovery_decisions(tenant_id,plan_revision_id,plan_node_id,attempt_number,created_at,id);

CREATE OR REPLACE FUNCTION finnor_os.guard_scope1_recovery_decision() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE loop_work uuid; step_loop uuid; step_work uuid; step_plan uuid; step_node text; step_attempt integer; plan_status text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'RecoveryDecisions are append-only immutable history'; END IF;
  SELECT work_id INTO loop_work FROM finnor_os.work_objective_loops
    WHERE tenant_id=NEW.tenant_id AND id=NEW.objective_loop_id AND revision=NEW.objective_revision;
  SELECT status INTO plan_status FROM finnor_os.work_plan_revisions
    WHERE tenant_id=NEW.tenant_id AND work_id=NEW.work_id AND id=NEW.plan_revision_id
      AND plan_graph->'nodes' @> jsonb_build_array(jsonb_build_object('id',NEW.plan_node_id));
  IF loop_work IS DISTINCT FROM NEW.work_id OR plan_status IS NULL THEN
    RAISE EXCEPTION 'RecoveryDecision crosses Work, Objective revision, or PlanNode boundary';
  END IF;
  IF NEW.objective_step_id IS NOT NULL THEN
    SELECT objective_loop_id,work_id,plan_revision_id,plan_node_id,attempt_number
      INTO step_loop,step_work,step_plan,step_node,step_attempt
      FROM finnor_os.work_objective_steps WHERE tenant_id=NEW.tenant_id AND id=NEW.objective_step_id;
    IF step_loop IS DISTINCT FROM NEW.objective_loop_id OR step_work IS DISTINCT FROM NEW.work_id
      OR step_plan IS DISTINCT FROM NEW.plan_revision_id OR step_node IS DISTINCT FROM NEW.plan_node_id
      OR step_attempt IS DISTINCT FROM NEW.attempt_number THEN
      RAISE EXCEPTION 'RecoveryDecision attempt identity mismatch';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER work_recovery_decisions_scope
  BEFORE INSERT OR UPDATE OR DELETE ON finnor_os.work_recovery_decisions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_scope1_recovery_decision();

-- Extend P6 immutability to compiler identity and deterministic revision history.
CREATE OR REPLACE FUNCTION finnor_os.guard_work_plan_revision_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'plan revisions are immutable history'; END IF;
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.work_id IS DISTINCT FROM NEW.work_id
    OR OLD.work_input_id IS DISTINCT FROM NEW.work_input_id OR OLD.planner_attempt_id IS DISTINCT FROM NEW.planner_attempt_id OR OLD.objective_loop_id IS DISTINCT FROM NEW.objective_loop_id
    OR OLD.revision IS DISTINCT FROM NEW.revision OR OLD.parent_revision_id IS DISTINCT FROM NEW.parent_revision_id
    OR OLD.reason IS DISTINCT FROM NEW.reason OR OLD.goal_spec IS DISTINCT FROM NEW.goal_spec
    OR OLD.constraint_set IS DISTINCT FROM NEW.constraint_set OR OLD.planning_snapshot IS DISTINCT FROM NEW.planning_snapshot
    OR OLD.candidate_summary IS DISTINCT FROM NEW.candidate_summary OR OLD.validation IS DISTINCT FROM NEW.validation OR OLD.plan_graph IS DISTINCT FROM NEW.plan_graph
    OR OLD.score IS DISTINCT FROM NEW.score OR OLD.goal_hash IS DISTINCT FROM NEW.goal_hash OR OLD.constraint_hash IS DISTINCT FROM NEW.constraint_hash
    OR OLD.world_snapshot_hash IS DISTINCT FROM NEW.world_snapshot_hash OR OLD.graph_hash IS DISTINCT FROM NEW.graph_hash OR OLD.semantic_hash IS DISTINCT FROM NEW.semantic_hash
    OR OLD.compiler_version IS DISTINCT FROM NEW.compiler_version OR OLD.revision_transition IS DISTINCT FROM NEW.revision_transition
    OR OLD.selected_at IS DISTINCT FROM NEW.selected_at THEN
    RAISE EXCEPTION 'plan revision semantic body is immutable';
  END IF;
  IF OLD.status<>'active' AND OLD.status IS DISTINCT FROM NEW.status THEN RAISE EXCEPTION 'terminal plan revision status is immutable'; END IF;
  IF OLD.completion_proof IS NOT NULL AND OLD.completion_proof IS DISTINCT FROM NEW.completion_proof THEN RAISE EXCEPTION 'completion proof is immutable once recorded'; END IF;
  IF NEW.status='completed' AND (NEW.completion_proof IS NULL OR NEW.completed_at IS NULL) THEN RAISE EXCEPTION 'completed plan requires CompletionProof'; END IF;
  RETURN NEW;
END $$;

-- Extend the durable wait contract with exact Plan/Objective generation pins.
CREATE OR REPLACE FUNCTION finnor_os.guard_phase4_event_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF TG_TABLE_NAME='integration_events' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.source IS DISTINCT FROM OLD.source OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id OR NEW.event_type IS DISTINCT FROM OLD.event_type OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR NEW.received_at IS DISTINCT FROM OLD.received_at OR NEW.party_type IS DISTINCT FROM OLD.party_type OR NEW.party_id IS DISTINCT FROM OLD.party_id OR NEW.resource_type IS DISTINCT FROM OLD.resource_type OR NEW.resource_id IS DISTINCT FROM OLD.resource_id OR NEW.work_id IS DISTINCT FROM OLD.work_id OR NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.delegation_id IS DISTINCT FROM OLD.delegation_id OR NEW.acknowledgement_request_id IS DISTINCT FROM OLD.acknowledgement_request_id OR NEW.computer_run_id IS DISTINCT FROM OLD.computer_run_id OR NEW.domain_action_id IS DISTINCT FROM OLD.domain_action_id OR NEW.provider_conversation_id IS DISTINCT FROM OLD.provider_conversation_id OR NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id OR NEW.application_ref IS DISTINCT FROM OLD.application_ref OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.evidence_refs IS DISTINCT FROM OLD.evidence_refs OR NEW.trust_class IS DISTINCT FROM OLD.trust_class OR NEW.content_treatment IS DISTINCT FROM OLD.content_treatment OR NEW.instruction_eligible IS DISTINCT FROM OLD.instruction_eligible OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'integration event evidence envelope is immutable'; END IF;
    IF OLD.status='matched' AND NEW.status<>'matched' THEN RAISE EXCEPTION 'matched integration event cannot regress'; END IF;
    IF OLD.status='ignored' AND NEW.status<>'ignored' THEN RAISE EXCEPTION 'ignored integration event cannot regress'; END IF;
  ELSIF TG_TABLE_NAME='work_event_waits' THEN
    IF OLD.status<>'waiting' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'terminal event wait is immutable'; END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.work_id IS DISTINCT FROM OLD.work_id OR NEW.objective_loop_id IS DISTINCT FROM OLD.objective_loop_id OR NEW.objective_step_id IS DISTINCT FROM OLD.objective_step_id OR NEW.plan_revision_id IS DISTINCT FROM OLD.plan_revision_id OR NEW.plan_node_id IS DISTINCT FROM OLD.plan_node_id OR NEW.objective_revision IS DISTINCT FROM OLD.objective_revision OR NEW.expected_event_type IS DISTINCT FROM OLD.expected_event_type OR NEW.subject_type IS DISTINCT FROM OLD.subject_type OR NEW.subject_id IS DISTINCT FROM OLD.subject_id OR NEW.resource_type IS DISTINCT FROM OLD.resource_type OR NEW.resource_id IS DISTINCT FROM OLD.resource_id OR NEW.delegation_id IS DISTINCT FROM OLD.delegation_id OR NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.acknowledgement_request_id IS DISTINCT FROM OLD.acknowledgement_request_id OR NEW.computer_run_id IS DISTINCT FROM OLD.computer_run_id OR NEW.domain_action_id IS DISTINCT FROM OLD.domain_action_id OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.provider_conversation_id IS DISTINCT FROM OLD.provider_conversation_id OR NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id OR NEW.application_ref IS DISTINCT FROM OLD.application_ref OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id OR NEW.condition_summary IS DISTINCT FROM OLD.condition_summary OR NEW.earliest_at IS DISTINCT FROM OLD.earliest_at OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at OR NEW.continuation_policy IS DISTINCT FROM OLD.continuation_policy OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'event wait correlation contract is immutable'; END IF;
  ELSIF TG_TABLE_NAME='work_wake_claims' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.wait_id IS DISTINCT FROM OLD.wait_id OR NEW.integration_event_id IS DISTINCT FROM OLD.integration_event_id OR NEW.objective_loop_id IS DISTINCT FROM OLD.objective_loop_id OR NEW.work_id IS DISTINCT FROM OLD.work_id OR NEW.cause IS DISTINCT FROM OLD.cause OR NEW.objective_revision IS DISTINCT FROM OLD.objective_revision OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN RAISE EXCEPTION 'wake claim is immutable'; END IF;
    IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN RAISE EXCEPTION 'consumed wake claim cannot regress or be rewritten'; END IF;
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE finnor_os.work_recovery_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.work_recovery_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finnor_os.work_recovery_decisions
  USING (tenant_id=finnor_os.request_tenant_id()) WITH CHECK (tenant_id=finnor_os.request_tenant_id());

DO $scope1_permissions$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    GRANT SELECT,INSERT ON finnor_os.work_recovery_decisions TO finnor_app;
    REVOKE UPDATE,DELETE ON finnor_os.work_recovery_decisions FROM finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.guard_scope1_recovery_decision() TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.assert_scope1_wait_generation() TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.assert_scope1_workforce_attempt() TO finnor_app;
  END IF;
END $scope1_permissions$;

DROP TRIGGER IF EXISTS work_recovery_decisions_operational_delta ON finnor_os.work_recovery_decisions;
CREATE TRIGGER work_recovery_decisions_operational_delta
  AFTER INSERT ON finnor_os.work_recovery_decisions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.append_operational_delta(
    'work_recovery_decision','work,actions,approvals,workflows,receipts,activity,queries','work_id','');

DROP TRIGGER IF EXISTS work_objective_loops_operational_delta ON finnor_os.work_objective_loops;
CREATE TRIGGER work_objective_loops_operational_delta
  AFTER INSERT OR UPDATE OF state,revision,step_count,action_count,query_count,
    node_attempt_count,wait_count,reserved_estimated_cost_micros,planner_failure_count,
    consecutive_no_progress,next_run_at,reason,next_step,last_observation,
    success_verification,success_verified_at,completed_at,cancelled_at
  ON finnor_os.work_objective_loops
  FOR EACH ROW EXECUTE FUNCTION finnor_os.append_operational_delta(
    'objective_loop','work,actions,approvals,workflows,receipts,activity,queries','work_id','');

DROP TRIGGER IF EXISTS work_objective_steps_operational_delta ON finnor_os.work_objective_steps;
CREATE TRIGGER work_objective_steps_operational_delta
  AFTER INSERT OR UPDATE OF phase,inspection,decision_kind,decision,authority_decision_id,
    query_execution_id,domain_action_id,observation,progress_made,iteration_outcome,
    recovery_kind,success_verification,verification_result,execution_state,claim_owner,
    claim_until,scheduled_for,failure,completed_at
  ON finnor_os.work_objective_steps
  FOR EACH ROW EXECUTE FUNCTION finnor_os.append_operational_delta(
    'objective_step','work,actions,approvals,workflows,receipts,activity,queries','work_id','');

COMMENT ON TABLE finnor_os.work_recovery_decisions IS 'Scope-1 append-only deterministic recovery semantics; runtime mechanics and external truth remain with their canonical owners.';
COMMENT ON COLUMN finnor_os.work_objective_steps.attempt_number IS 'Logical PlanNode attempt. Duplicate physical deliveries share one row; an explicit retry creates a new number.';
COMMENT ON COLUMN finnor_os.work_event_waits.plan_revision_id IS 'Nullable only for pre-Scope-1 history; new PlanGraph waits pin the exact immutable revision and node.';
