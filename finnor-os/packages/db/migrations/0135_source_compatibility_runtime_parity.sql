-- Restore production-only runtime objects that are not present in the fresh
-- project's migration lineage. These are additive parity repairs: the source
-- project remains untouched, and no historical rows are rewritten.

CREATE OR REPLACE FUNCTION finnor_os.append_product_truth_operational_delta()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'finnor_os'
AS $function$
DECLARE
  tenant uuid := (to_jsonb(NEW)->>'tenant_id')::uuid;
  row_id uuid := (to_jsonb(NEW)->>'id')::uuid;
  work uuid;
  next_seq bigint;
  priority_value text := 'normal';
  refs jsonb;
  tags text[] := ARRAY['work','actions','approvals','workflows','receipts','activity','queries'];
  status_value text := coalesce(to_jsonb(NEW)->>'status','');
BEGIN
  IF tenant IS NULL THEN RAISE EXCEPTION 'product truth delta source has no tenant'; END IF;

  IF TG_TABLE_NAME='work_objective_planner_attempts' THEN
    SELECT loop.work_id INTO work
      FROM finnor_os.work_objective_loops loop
      WHERE loop.tenant_id=tenant AND loop.id=(to_jsonb(NEW)->>'objective_loop_id')::uuid;
  ELSIF TG_TABLE_NAME='business_effects' THEN
    SELECT action.work_id INTO work
      FROM finnor_os.domain_actions action
      WHERE action.tenant_id=tenant AND action.id=(to_jsonb(NEW)->>'domain_action_id')::uuid;
  ELSIF TG_TABLE_NAME='workflow_steps' THEN
    SELECT run.work_id INTO work
      FROM finnor_os.workflow_runs run
      WHERE run.tenant_id=tenant AND run.id=(to_jsonb(NEW)->>'workflow_run_id')::uuid;
  ELSIF TG_TABLE_NAME='authority_approval_requests' THEN
    SELECT action.work_id INTO work
      FROM finnor_os.domain_actions action
      WHERE action.tenant_id=tenant AND action.id=(to_jsonb(NEW)->>'domain_action_id')::uuid;
  ELSIF TG_TABLE_NAME='authority_approval_request_steps' THEN
    SELECT action.work_id INTO work
      FROM finnor_os.authority_approval_requests request
      JOIN finnor_os.domain_actions action
        ON action.tenant_id=request.tenant_id AND action.id=request.domain_action_id
      WHERE request.tenant_id=tenant AND request.id=(to_jsonb(NEW)->>'approval_request_id')::uuid;
  ELSE
    RAISE EXCEPTION 'unsupported product truth delta source: %',TG_TABLE_NAME;
  END IF;

  IF status_value IN ('failed','timed_out','blocked','rejected','invalid') THEN
    priority_value := 'high';
  END IF;
  refs := jsonb_build_array(jsonb_build_object(
    'entityType',CASE TG_TABLE_NAME
      WHEN 'work_objective_planner_attempts' THEN 'objective_planner_attempt'
      WHEN 'business_effects' THEN 'business_effect'
      WHEN 'workflow_steps' THEN 'workflow_step'
      WHEN 'authority_approval_requests' THEN 'approval_request'
      ELSE 'approval_request_step'
    END,
    'entityId',row_id
  ));

  INSERT INTO finnor_os.tenant_operational_delta_cursors(tenant_id,last_seq)
  VALUES (tenant,1)
  ON CONFLICT (tenant_id) DO UPDATE
    SET last_seq=finnor_os.tenant_operational_delta_cursors.last_seq+1,updated_at=now()
  RETURNING last_seq INTO next_seq;

  INSERT INTO finnor_os.operational_deltas(
    tenant_id,seq,change_type,priority,entity_refs,work_id,projection_tags
  ) VALUES (
    tenant,next_seq,TG_TABLE_NAME||'.'||lower(TG_OP),priority_value,refs,work,tags
  );

  PERFORM pg_notify('jarvis_events',json_build_object(
    'tenantId',tenant,'kind','operational_delta','id',next_seq::text,
    'ts',to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::text);
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION finnor_os.forbid_legacy_communications_write()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'communications_log_legacy is frozen; write customer communication through canonical messages';
END $function$;

-- Source-compatible immutable legacy communication history.
DROP TRIGGER IF EXISTS communications_log_legacy_read_only ON finnor_os.communications_log_legacy;
CREATE TRIGGER communications_log_legacy_read_only
  BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON finnor_os.communications_log_legacy
  FOR EACH STATEMENT EXECUTE FUNCTION finnor_os.forbid_legacy_communications_write();

DROP TRIGGER IF EXISTS communications_log_scope ON finnor_os.communications_log_legacy;
CREATE TRIGGER communications_log_scope
  BEFORE INSERT OR UPDATE OF tenant_id, household_id ON finnor_os.communications_log_legacy
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_household_child_scope();

DROP TRIGGER IF EXISTS retired_water_tenant_read_only ON finnor_os.communications_log_legacy;
CREATE TRIGGER retired_water_tenant_read_only
  BEFORE INSERT OR DELETE OR UPDATE ON finnor_os.communications_log_legacy
  FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_retired_water_tenant();

-- Product-truth operational delta triggers.
DROP TRIGGER IF EXISTS authority_approval_request_steps_operational_delta ON finnor_os.authority_approval_request_steps;
CREATE TRIGGER authority_approval_request_steps_operational_delta
  AFTER INSERT OR UPDATE OF status, decided_by, authority_decision_id, decided_at
  ON finnor_os.authority_approval_request_steps
  FOR EACH ROW EXECUTE FUNCTION finnor_os.append_product_truth_operational_delta();

DROP TRIGGER IF EXISTS authority_approval_requests_operational_delta ON finnor_os.authority_approval_requests;
CREATE TRIGGER authority_approval_requests_operational_delta
  AFTER INSERT OR UPDATE OF status, current_step, resolved_at
  ON finnor_os.authority_approval_requests
  FOR EACH ROW EXECUTE FUNCTION finnor_os.append_product_truth_operational_delta();

DROP TRIGGER IF EXISTS business_effects_operational_delta ON finnor_os.business_effects;
CREATE TRIGGER business_effects_operational_delta
  AFTER INSERT OR UPDATE OF status, verification, observed_at
  ON finnor_os.business_effects
  FOR EACH ROW EXECUTE FUNCTION finnor_os.append_product_truth_operational_delta();

DROP TRIGGER IF EXISTS workflow_steps_operational_delta ON finnor_os.workflow_steps;
CREATE TRIGGER workflow_steps_operational_delta
  AFTER INSERT OR UPDATE OF status, execution_state, lease_expires_at, attempts,
    terminal_reason, claimed_at, effect_commit_at, cancellation_requested_at
  ON finnor_os.workflow_steps
  FOR EACH ROW EXECUTE FUNCTION finnor_os.append_product_truth_operational_delta();

DROP TRIGGER IF EXISTS work_objective_planner_attempts_operational_delta ON finnor_os.work_objective_planner_attempts;
CREATE TRIGGER work_objective_planner_attempts_operational_delta
  AFTER INSERT OR UPDATE OF status, provider, decision, failure, completed_at
  ON finnor_os.work_objective_planner_attempts
  FOR EACH ROW EXECUTE FUNCTION finnor_os.append_product_truth_operational_delta();

DROP TRIGGER IF EXISTS work_objective_loops_operational_delta ON finnor_os.work_objective_loops;
CREATE TRIGGER work_objective_loops_operational_delta
  AFTER INSERT OR UPDATE OF state, revision, step_count, action_count, query_count,
    planner_failure_count, consecutive_no_progress, next_run_at, reason, next_step,
    last_observation, success_verification, success_verified_at, completed_at, cancelled_at
  ON finnor_os.work_objective_loops
  FOR EACH ROW EXECUTE FUNCTION finnor_os.append_operational_delta(
    'objective_loop', 'work,actions,approvals,workflows,receipts,activity,queries', 'work_id', '');

DROP TRIGGER IF EXISTS work_objective_steps_operational_delta ON finnor_os.work_objective_steps;
CREATE TRIGGER work_objective_steps_operational_delta
  AFTER INSERT OR UPDATE OF phase, inspection, decision_kind, decision, authority_decision_id,
    query_execution_id, domain_action_id, observation, progress_made, iteration_outcome,
    recovery_kind, success_verification, scheduled_for, failure, completed_at
  ON finnor_os.work_objective_steps
  FOR EACH ROW EXECUTE FUNCTION finnor_os.append_operational_delta(
    'objective_step', 'work,actions,approvals,workflows,receipts,activity,queries', 'work_id', '');

DROP TRIGGER IF EXISTS work_wake_claims_operational_delta ON finnor_os.work_wake_claims;
CREATE TRIGGER work_wake_claims_operational_delta
  AFTER INSERT OR UPDATE OF consumed_at ON finnor_os.work_wake_claims
  FOR EACH ROW EXECUTE FUNCTION finnor_os.append_operational_delta(
    'work_wake_claim', 'work,actions,approvals,workflows,receipts,activity,queries', 'work_id', '');

DROP TRIGGER IF EXISTS work_event_waits_operational_delta ON finnor_os.work_event_waits;
CREATE TRIGGER work_event_waits_operational_delta
  AFTER INSERT OR UPDATE OF status, matched_event_id, satisfied_at, timed_out_at,
    cancelled_at, earliest_at, deadline_at, updated_at
  ON finnor_os.work_event_waits
  FOR EACH ROW EXECUTE FUNCTION finnor_os.append_operational_delta(
    'work_event_wait', 'work,actions,approvals,workflows,receipts,activity,queries', 'work_id', '');

-- Source indexes whose names cannot be created on the fresh canonical table
-- because the canonical table already owns those legacy names.
CREATE INDEX IF NOT EXISTS communications_log_legacy_household_timestamp_id_idx
  ON finnor_os.communications_log_legacy (household_id, "timestamp" DESC, id);
CREATE INDEX IF NOT EXISTS communications_log_legacy_tenant_household_time_idx
  ON finnor_os.communications_log_legacy (tenant_id, household_id, "timestamp" DESC, id);
CREATE UNIQUE INDEX IF NOT EXISTS messages_tenant_source_external_unique
  ON finnor_os.messages (tenant_id, source_system, external_id)
  WHERE source_system IS NOT NULL AND external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS work_inputs_tenant_intake_deadline_idx
  ON finnor_os.work_inputs (tenant_id, intake_deadline_at)
  WHERE intake_deadline_at IS NOT NULL;
