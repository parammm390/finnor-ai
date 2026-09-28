-- P7 specialists finish their own approval-wait iteration while the Objective
-- controller may still run independent branches. Global state is not the node's
-- approval boundary. Preserve the legacy contract and fence modern waits by their
-- exact active PlanRevision, Objective revision, node, Work, and tenant.
CREATE OR REPLACE FUNCTION finnor_os.assert_objective_action_execution_active() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  step_row record;
BEGIN
  IF NEW.objective_step_id IS NULL OR NEW.status <> 'executing' OR OLD.status='executing' THEN
    RETURN NEW;
  END IF;

  SELECT s.tenant_id,s.work_id,s.completed_at,s.iteration_outcome,
         s.execution_state,s.objective_revision,s.plan_revision_id,s.plan_node_id,
         l.state AS loop_state,l.revision AS loop_revision,
         w.status AS work_status,p.status AS plan_status,p.work_id AS plan_work_id
    INTO step_row
  FROM finnor_os.work_objective_steps s
  JOIN finnor_os.work_objective_loops l
    ON l.id=s.objective_loop_id AND l.tenant_id=s.tenant_id AND l.work_id=s.work_id
  JOIN finnor_os.works w ON w.id=s.work_id AND w.tenant_id=s.tenant_id
  LEFT JOIN finnor_os.work_plan_revisions p
    ON p.id=s.plan_revision_id AND p.tenant_id=s.tenant_id
  WHERE s.id=NEW.objective_step_id;

  IF NOT FOUND OR step_row.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR step_row.work_id IS DISTINCT FROM NEW.work_id
    OR step_row.loop_state IN ('blocked','completed','failed','cancelled')
    OR step_row.work_status IN ('completed','failed','cancelled')
    OR step_row.execution_state IN ('failed','reconciliation_required','cancelled','superseded')
    OR (step_row.objective_revision IS NOT NULL
        AND step_row.objective_revision IS DISTINCT FROM step_row.loop_revision) THEN
    RAISE EXCEPTION 'objective action execution refused because its exact generation is inactive';
  END IF;

  IF NEW.plan_revision_id IS NOT NULL OR step_row.plan_revision_id IS NOT NULL THEN
    IF step_row.plan_revision_id IS DISTINCT FROM NEW.plan_revision_id
      OR step_row.plan_node_id IS DISTINCT FROM NEW.plan_node_id
      OR step_row.plan_work_id IS DISTINCT FROM NEW.work_id
      OR step_row.plan_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'objective action execution refused because its exact plan is inactive';
    END IF;
  END IF;

  IF NOT (
    (step_row.completed_at IS NULL AND step_row.loop_state='continue')
    OR (step_row.iteration_outcome='awaiting_approval'
        AND step_row.loop_state='awaiting_approval')
    OR (step_row.iteration_outcome='awaiting_approval'
        AND step_row.execution_state='waiting'
        AND step_row.objective_revision IS NOT NULL
        AND step_row.plan_revision_id IS NOT NULL
        AND step_row.loop_state IN ('continue','waiting'))
  ) THEN
    RAISE EXCEPTION 'objective action execution refused because its step is finished or inactive';
  END IF;
  RETURN NEW;
END $$;
