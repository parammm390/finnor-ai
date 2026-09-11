-- P6: deterministic planning and causal attention.
-- The model may propose candidate graphs; this immutable row records only the
-- graph selected by the deterministic compiler. Existing DomainAction,
-- BusinessEffect, ObjectiveLoop, wait, receipt, Evidence, and PE owners remain
-- authoritative for execution and business truth.

CREATE TABLE finnor_os.work_plan_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  work_id uuid NOT NULL,
  work_input_id uuid NOT NULL REFERENCES finnor_os.work_inputs(id),
  planner_attempt_id uuid,
  objective_loop_id uuid,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 1000),
  parent_revision_id uuid,
  reason text NOT NULL CHECK (reason IN ('initial','observation','failure','stale','timeout','redirect')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','completed','blocked','failed')),
  goal_spec jsonb NOT NULL CHECK (jsonb_typeof(goal_spec)='object' AND goal_spec->>'version'='1' AND octet_length(goal_spec::text)<=131072),
  constraint_set jsonb NOT NULL CHECK (jsonb_typeof(constraint_set)='object' AND constraint_set->>'version'='1' AND octet_length(constraint_set::text)<=131072),
  planning_snapshot jsonb NOT NULL CHECK (jsonb_typeof(planning_snapshot)='object' AND planning_snapshot->>'version'='1' AND octet_length(planning_snapshot::text)<=262144),
  candidate_summary jsonb NOT NULL CHECK (jsonb_typeof(candidate_summary)='object' AND octet_length(candidate_summary::text)<=262144),
  validation jsonb NOT NULL CHECK (jsonb_typeof(validation)='object' AND validation->>'version'='1' AND octet_length(validation::text)<=262144),
  plan_graph jsonb NOT NULL CHECK (jsonb_typeof(plan_graph)='object' AND plan_graph->>'version'='1' AND octet_length(plan_graph::text)<=262144),
  score jsonb NOT NULL CHECK (jsonb_typeof(score)='object' AND octet_length(score::text)<=32768),
  goal_hash text NOT NULL CHECK (goal_hash ~ '^sha256:[0-9a-f]{64}$'),
  constraint_hash text NOT NULL CHECK (constraint_hash ~ '^sha256:[0-9a-f]{64}$'),
  world_snapshot_hash text NOT NULL CHECK (world_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  graph_hash text NOT NULL CHECK (graph_hash ~ '^sha256:[0-9a-f]{64}$'),
  semantic_hash text NOT NULL CHECK (semantic_hash ~ '^sha256:[0-9a-f]{64}$'),
  completion_proof jsonb CHECK (completion_proof IS NULL OR (
    jsonb_typeof(completion_proof)='object' AND completion_proof->>'version'='1'
    AND completion_proof->>'verified'='true' AND completion_proof->>'finalPlanRevisionId'=id::text
    AND completion_proof->>'planRevisionId'=id::text AND completion_proof->>'planSemanticHash'=graph_hash
    AND completion_proof->>'goalSemanticHash'=goal_hash AND completion_proof->>'successConditionHash' ~ '^sha256:[0-9a-f]{64}$'
    AND octet_length(completion_proof::text)<=262144
  )),
  selected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (tenant_id,id),
  UNIQUE (work_id,revision),
  UNIQUE (tenant_id,work_id,id),
  UNIQUE (tenant_id,work_id,semantic_hash),
  FOREIGN KEY (tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
  FOREIGN KEY (tenant_id,work_id,parent_revision_id) REFERENCES finnor_os.work_plan_revisions(tenant_id,work_id,id),
  FOREIGN KEY (planner_attempt_id) REFERENCES finnor_os.work_planner_attempts(id),
  FOREIGN KEY (objective_loop_id) REFERENCES finnor_os.work_objective_loops(id),
  CHECK ((revision=1)=(parent_revision_id IS NULL)),
  CHECK (goal_hash=goal_spec->>'semanticHash'),
  CHECK (constraint_hash=constraint_set->>'semanticHash'),
  CHECK (world_snapshot_hash=planning_snapshot->>'semanticHash'),
  CHECK (graph_hash=plan_graph->>'semanticHash' AND semantic_hash=graph_hash),
  CHECK ((status='completed' AND completion_proof IS NOT NULL AND completed_at IS NOT NULL)
    OR (status<>'completed' AND completion_proof IS NULL AND completed_at IS NULL))
);
CREATE UNIQUE INDEX work_plan_revisions_one_active_idx ON finnor_os.work_plan_revisions(work_id) WHERE status='active';
CREATE INDEX work_plan_revisions_tenant_work_idx ON finnor_os.work_plan_revisions(tenant_id,work_id,revision DESC);
CREATE INDEX work_plan_revisions_tenant_status_idx ON finnor_os.work_plan_revisions(tenant_id,status,selected_at DESC);

ALTER TABLE finnor_os.work_planner_attempts
  ADD COLUMN goal_spec jsonb,
  ADD COLUMN constraint_set jsonb,
  ADD COLUMN planning_snapshot jsonb,
  ADD COLUMN candidate_plans jsonb,
  ADD COLUMN compilation_result jsonb,
  ADD COLUMN selected_plan_revision_id uuid REFERENCES finnor_os.work_plan_revisions(id);

ALTER TABLE finnor_os.domain_actions
  ADD COLUMN plan_revision_id uuid,
  ADD COLUMN plan_node_id text;
ALTER TABLE finnor_os.domain_actions
  ADD CONSTRAINT domain_actions_plan_link_pair CHECK ((plan_revision_id IS NULL)=(plan_node_id IS NULL)),
  ADD CONSTRAINT domain_actions_plan_revision_fkey FOREIGN KEY (tenant_id,work_id,plan_revision_id)
    REFERENCES finnor_os.work_plan_revisions(tenant_id,work_id,id);
CREATE UNIQUE INDEX domain_actions_plan_node_unique ON finnor_os.domain_actions(plan_revision_id,plan_node_id) WHERE plan_revision_id IS NOT NULL;
CREATE INDEX domain_actions_tenant_plan_revision_idx ON finnor_os.domain_actions(tenant_id,plan_revision_id);

ALTER TABLE finnor_os.work_objective_steps
  ADD COLUMN plan_revision_id uuid,
  ADD COLUMN plan_node_id text;
ALTER TABLE finnor_os.work_objective_steps
  ADD CONSTRAINT work_objective_steps_plan_link_pair CHECK ((plan_revision_id IS NULL)=(plan_node_id IS NULL)),
  ADD CONSTRAINT work_objective_steps_plan_revision_fkey FOREIGN KEY (tenant_id,work_id,plan_revision_id)
    REFERENCES finnor_os.work_plan_revisions(tenant_id,work_id,id);

ALTER TABLE finnor_os.work_query_executions DROP CONSTRAINT IF EXISTS work_query_executions_intent_check;
ALTER TABLE finnor_os.work_query_executions ADD CONSTRAINT work_query_executions_intent_check CHECK (intent IN (
  'customer_lookup','customer_cohort','schedule_range','money_summary','work_list','attention_queue',
  'inventory_status','agent_activity','business_state','company_context','party_lookup','party_context','team_roster','party_availability',
  'deal_context','deal_workstreams','open_requests','open_findings','open_deal_risks','critical_dependencies','closing_readiness','pe_world_state'
));

CREATE OR REPLACE FUNCTION finnor_os.assert_work_plan_revision_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE work_tenant uuid; input_tenant uuid; input_work uuid; attempt_tenant uuid; attempt_work uuid; loop_tenant uuid; loop_work uuid; parent_revision integer;
BEGIN
  SELECT tenant_id INTO work_tenant FROM finnor_os.works WHERE id=NEW.work_id;
  IF work_tenant IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'plan revision Work does not belong to tenant'; END IF;
  SELECT tenant_id,work_id INTO input_tenant,input_work FROM finnor_os.work_inputs WHERE id=NEW.work_input_id;
  IF input_tenant IS DISTINCT FROM NEW.tenant_id OR input_work IS DISTINCT FROM NEW.work_id THEN RAISE EXCEPTION 'plan revision WorkInput scope mismatch'; END IF;
  IF NEW.planner_attempt_id IS NOT NULL THEN
    SELECT tenant_id,work_id INTO attempt_tenant,attempt_work FROM finnor_os.work_planner_attempts WHERE id=NEW.planner_attempt_id;
    IF attempt_tenant IS DISTINCT FROM NEW.tenant_id OR attempt_work IS DISTINCT FROM NEW.work_id THEN RAISE EXCEPTION 'plan revision attempt scope mismatch'; END IF;
  END IF;
  IF NEW.objective_loop_id IS NOT NULL THEN
    SELECT tenant_id,work_id INTO loop_tenant,loop_work FROM finnor_os.work_objective_loops WHERE id=NEW.objective_loop_id;
    IF loop_tenant IS DISTINCT FROM NEW.tenant_id OR loop_work IS DISTINCT FROM NEW.work_id THEN RAISE EXCEPTION 'plan revision objective scope mismatch'; END IF;
  END IF;
  IF NEW.parent_revision_id IS NOT NULL THEN
    SELECT revision INTO parent_revision FROM finnor_os.work_plan_revisions
      WHERE id=NEW.parent_revision_id AND tenant_id=NEW.tenant_id AND work_id=NEW.work_id;
    IF parent_revision IS NULL OR parent_revision+1<>NEW.revision THEN RAISE EXCEPTION 'plan revision must follow its exact parent'; END IF;
  END IF;
  RETURN NEW;
END $$;

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
    OR OLD.selected_at IS DISTINCT FROM NEW.selected_at THEN
    RAISE EXCEPTION 'plan revision semantic body is immutable';
  END IF;
  IF OLD.status<>'active' AND OLD.status IS DISTINCT FROM NEW.status THEN RAISE EXCEPTION 'terminal plan revision status is immutable'; END IF;
  IF OLD.completion_proof IS NOT NULL AND OLD.completion_proof IS DISTINCT FROM NEW.completion_proof THEN RAISE EXCEPTION 'completion proof is immutable once recorded'; END IF;
  IF NEW.status='completed' AND (NEW.completion_proof IS NULL OR NEW.completed_at IS NULL) THEN RAISE EXCEPTION 'completed plan requires CompletionProof'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER work_plan_revisions_scope BEFORE INSERT ON finnor_os.work_plan_revisions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_work_plan_revision_scope();
CREATE TRIGGER work_plan_revisions_immutable BEFORE UPDATE OR DELETE ON finnor_os.work_plan_revisions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_work_plan_revision_mutation();

CREATE OR REPLACE FUNCTION finnor_os.assert_domain_action_plan_link() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE graph jsonb; plan_status text; node jsonb; expected_payload jsonb;
BEGIN
  IF NEW.plan_revision_id IS NULL THEN RETURN NEW; END IF;
  SELECT plan_graph,status INTO graph,plan_status FROM finnor_os.work_plan_revisions WHERE id=NEW.plan_revision_id AND tenant_id=NEW.tenant_id AND work_id=NEW.work_id;
  SELECT value INTO node FROM jsonb_array_elements(coalesce(graph->'nodes','[]'::jsonb)) WHERE value->>'id'=NEW.plan_node_id LIMIT 1;
  expected_payload := coalesce(node->'groundedPayload',node->'payload');
  IF node IS NULL OR node->>'kind'<>'action' OR node->>'actionType' IS DISTINCT FROM NEW.action_type THEN
    RAISE EXCEPTION 'DomainAction must exactly materialize one action PlanNode';
  END IF;
  IF TG_OP='INSERT' AND expected_payload IS DISTINCT FROM NEW.payload THEN
    RAISE EXCEPTION 'DomainAction initial payload must exactly match its selected action PlanNode';
  END IF;
  IF TG_OP='UPDATE' AND OLD.payload IS DISTINCT FROM NEW.payload AND NOT (
    OLD.status='draft' AND NEW.status='draft' AND OLD.payload=expected_payload
    AND OLD.grounded_payload IS NULL AND NEW.grounded_payload IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Only the one deterministic draft grounding transition may enrich a planned DomainAction payload';
  END IF;
  IF NEW.status IN ('draft','pending','approved','executing') AND plan_status<>'active' THEN
    RAISE EXCEPTION 'DomainAction cannot become executable from a non-active PlanRevision';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER domain_actions_plan_link BEFORE INSERT OR UPDATE OF plan_revision_id,plan_node_id,action_type,payload,work_id,tenant_id,status ON finnor_os.domain_actions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_domain_action_plan_link();

ALTER TABLE finnor_os.work_plan_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.work_plan_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finnor_os.work_plan_revisions
  USING (tenant_id=(SELECT finnor_os.request_tenant_id())) WITH CHECK (tenant_id=(SELECT finnor_os.request_tenant_id()));
DO $p6_permissions$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    GRANT SELECT,INSERT,UPDATE(status,completion_proof,completed_at) ON finnor_os.work_plan_revisions TO finnor_app;
    REVOKE DELETE ON finnor_os.work_plan_revisions FROM finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.assert_work_plan_revision_scope() TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.guard_work_plan_revision_mutation() TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.assert_domain_action_plan_link() TO finnor_app;
  END IF;
END $p6_permissions$;

COMMENT ON TABLE finnor_os.work_plan_revisions IS 'P6 immutable deterministic-compiler selection; not a workflow engine or source of business truth.';
COMMENT ON COLUMN finnor_os.work_plan_revisions.candidate_summary IS 'Bounded proposal and typed violation ledger; model rationale is audit context, never execution authority.';
