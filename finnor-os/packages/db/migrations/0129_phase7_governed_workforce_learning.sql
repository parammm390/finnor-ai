-- P7: governed AI workforce and evidence-bounded learning.
-- P6 remains the sole owner of Plan validity and canonical execution. These
-- tables identify non-human workers, lease one already-selected PlanNode, and
-- preserve verified outcomes/soft guidance without creating authority.

ALTER TABLE finnor_os.work_query_executions DROP CONSTRAINT IF EXISTS work_query_executions_intent_check;
ALTER TABLE finnor_os.work_query_executions ADD CONSTRAINT work_query_executions_intent_check CHECK (intent IN (
  'customer_lookup','customer_cohort','schedule_range','money_summary','work_list','attention_queue',
  'inventory_status','agent_activity','workforce_status','business_state','company_context','party_lookup','party_context','team_roster','party_availability',
  'deal_context','deal_workstreams','open_requests','open_findings','open_deal_risks','critical_dependencies','closing_readiness','pe_world_state'
));

-- P7 uses a tenant-qualified FK for ObjectiveStep identity. The UUID primary
-- key already makes each row unique; this additive key lets Postgres enforce
-- the tenant boundary in the FK itself instead of relying only on a trigger.
ALTER TABLE finnor_os.work_objective_steps
  ADD CONSTRAINT work_objective_steps_tenant_id_id_key UNIQUE (tenant_id,id);

CREATE TABLE finnor_os.agent_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  key text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','disabled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,key)
);
CREATE INDEX agent_profiles_tenant_status_idx ON finnor_os.agent_profiles(tenant_id,status,id);

CREATE TABLE finnor_os.learning_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  target_agent_profile_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 10000),
  parent_revision_id uuid,
  source_proposal_id uuid NOT NULL,
  guidance jsonb NOT NULL CHECK (jsonb_typeof(guidance)='object' AND octet_length(guidance::text)<=131072),
  semantic_hash text NOT NULL CHECK (semantic_hash ~ '^sha256:[0-9a-f]{64}$'),
  promoted_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,target_agent_profile_id,id),
  UNIQUE (target_agent_profile_id,revision),
  UNIQUE (source_proposal_id),
  UNIQUE (tenant_id,target_agent_profile_id,semantic_hash),
  FOREIGN KEY (tenant_id,target_agent_profile_id) REFERENCES finnor_os.agent_profiles(tenant_id,id),
  FOREIGN KEY (tenant_id,promoted_by) REFERENCES finnor_os.users(tenant_id,id),
  FOREIGN KEY (tenant_id,target_agent_profile_id,parent_revision_id) REFERENCES finnor_os.learning_revisions(tenant_id,target_agent_profile_id,id),
  CHECK ((revision=1)=(parent_revision_id IS NULL))
);
CREATE INDEX learning_revisions_tenant_profile_idx ON finnor_os.learning_revisions(tenant_id,target_agent_profile_id,revision DESC);

CREATE TABLE finnor_os.agent_profile_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  agent_profile_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 10000),
  model_route jsonb NOT NULL CHECK (
    jsonb_typeof(model_route)='object' AND model_route->>'purpose'='objective_execution'
    AND length(coalesce(model_route->>'provider','')) BETWEEN 1 AND 120
    AND octet_length(model_route::text)<=4096
  ),
  capability_grants jsonb NOT NULL CHECK (jsonb_typeof(capability_grants)='array' AND jsonb_array_length(capability_grants) BETWEEN 1 AND 512 AND octet_length(capability_grants::text)<=131072),
  max_concurrent_assignments integer NOT NULL DEFAULT 1 CHECK (max_concurrent_assignments BETWEEN 1 AND 32),
  autonomy_limits jsonb NOT NULL CHECK (
    jsonb_typeof(autonomy_limits)='object'
    AND (autonomy_limits->>'maxActions')::integer BETWEEN 1 AND 4
    AND (autonomy_limits->>'maxQueries')::integer BETWEEN 1 AND 11
    AND (autonomy_limits->>'maxReplans')::integer BETWEEN 1 AND 8
    AND (autonomy_limits->>'maxPlannerCalls')::integer BETWEEN 1 AND 11
    AND (autonomy_limits->>'maxWallClockMs')::integer BETWEEN 1000 AND 604799999
    AND octet_length(autonomy_limits::text)<=8192
  ),
  planning_hints jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(planning_hints)='object' AND octet_length(planning_hints::text)<=32768),
  learning_revision_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','disabled')),
  config_hash text NOT NULL CHECK (config_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (agent_profile_id,revision),
  UNIQUE (agent_profile_id,config_hash),
  FOREIGN KEY (tenant_id,agent_profile_id) REFERENCES finnor_os.agent_profiles(tenant_id,id),
  FOREIGN KEY (tenant_id,learning_revision_id) REFERENCES finnor_os.learning_revisions(tenant_id,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE UNIQUE INDEX agent_profile_revisions_one_active_idx ON finnor_os.agent_profile_revisions(agent_profile_id) WHERE status='active';
CREATE INDEX agent_profile_revisions_tenant_status_idx ON finnor_os.agent_profile_revisions(tenant_id,status,id);

CREATE TABLE finnor_os.workforce_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  work_id uuid NOT NULL,
  plan_revision_id uuid NOT NULL,
  plan_node_id text NOT NULL CHECK (length(plan_node_id) BETWEEN 1 AND 160),
  objective_loop_id uuid,
  objective_step_id uuid,
  agent_profile_id uuid NOT NULL,
  agent_revision_id uuid NOT NULL,
  capability text NOT NULL CHECK (length(capability) BETWEEN 1 AND 240),
  node_kind text NOT NULL CHECK (node_kind IN ('query','action','wait','check')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','claimed','running','waiting','completed','failed','cancelled','reassigned')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 100),
  lease_owner text,
  lease_until timestamptz,
  budget_snapshot jsonb NOT NULL CHECK (jsonb_typeof(budget_snapshot)='object' AND octet_length(budget_snapshot::text)<=32768),
  assignment_reason text NOT NULL CHECK (length(assignment_reason) BETWEEN 1 AND 2000),
  assignment_score jsonb NOT NULL CHECK (jsonb_typeof(assignment_score)='object' AND octet_length(assignment_score::text)<=32768),
  previous_assignment_id uuid,
  reassignment_reason text,
  domain_action_id uuid,
  started_at timestamptz,
  completed_at timestamptz,
  failure jsonb CHECK (failure IS NULL OR (jsonb_typeof(failure)='object' AND octet_length(failure::text)<=32768)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
  FOREIGN KEY (tenant_id,work_id,plan_revision_id) REFERENCES finnor_os.work_plan_revisions(tenant_id,work_id,id),
  FOREIGN KEY (tenant_id,objective_loop_id) REFERENCES finnor_os.work_objective_loops(tenant_id,id),
  FOREIGN KEY (tenant_id,objective_step_id) REFERENCES finnor_os.work_objective_steps(tenant_id,id),
  FOREIGN KEY (tenant_id,agent_profile_id) REFERENCES finnor_os.agent_profiles(tenant_id,id),
  FOREIGN KEY (tenant_id,agent_revision_id) REFERENCES finnor_os.agent_profile_revisions(tenant_id,id),
  FOREIGN KEY (tenant_id,previous_assignment_id) REFERENCES finnor_os.workforce_assignments(tenant_id,id),
  FOREIGN KEY (tenant_id,domain_action_id) REFERENCES finnor_os.domain_actions(tenant_id,id),
  CHECK ((lease_owner IS NULL)=(lease_until IS NULL)),
  CHECK (state NOT IN ('claimed','running') OR lease_owner IS NOT NULL),
  CHECK (state NOT IN ('completed','failed','cancelled','reassigned') OR completed_at IS NOT NULL),
  -- A replacement must explain why it follows prior ownership. The prior row
  -- may independently record why it relinquished even though it has no parent.
  CHECK (previous_assignment_id IS NULL OR reassignment_reason IS NOT NULL)
);
CREATE UNIQUE INDEX workforce_assignments_one_active_node_idx ON finnor_os.workforce_assignments(plan_revision_id,plan_node_id)
  WHERE state IN ('queued','claimed','running','waiting');
CREATE INDEX workforce_assignments_tenant_profile_state_idx ON finnor_os.workforce_assignments(tenant_id,agent_profile_id,state,created_at DESC);
CREATE INDEX workforce_assignments_tenant_work_idx ON finnor_os.workforce_assignments(tenant_id,work_id,created_at DESC);
CREATE INDEX workforce_assignments_tenant_state_created_idx ON finnor_os.workforce_assignments(tenant_id,state,created_at,id);
CREATE INDEX workforce_assignments_expired_lease_idx ON finnor_os.workforce_assignments(tenant_id,lease_until)
  WHERE state IN ('claimed','running');
CREATE INDEX work_objective_steps_workforce_boundary_idx ON finnor_os.work_objective_steps(tenant_id,started_at,id)
  WHERE iteration_outcome IN ('waiting','blocked') AND observation ? 'workforceStatus';

CREATE TABLE finnor_os.learning_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  agent_profile_id uuid NOT NULL,
  agent_revision_id uuid NOT NULL,
  workforce_assignment_id uuid NOT NULL,
  capability text NOT NULL CHECK (length(capability) BETWEEN 1 AND 240),
  node_kind text NOT NULL CHECK (node_kind IN ('query','action','wait','check')),
  context_class text NOT NULL CHECK (context_class ~ '^[a-z0-9][a-z0-9._:-]{0,119}$'),
  work_id uuid NOT NULL,
  plan_revision_id uuid NOT NULL,
  plan_node_id text NOT NULL,
  outcome_class text NOT NULL CHECK (outcome_class IN (
    'verified_completion','agent_planning_failure','schema_compile_rejection','authority_denial','human_rejection','human_correction',
    'provider_outage','external_failure','stale_world_replan','business_outcome_failure','timeout','user_cancellation','recovery','unknown'
  )),
  verified boolean NOT NULL,
  source_refs jsonb NOT NULL CHECK (jsonb_typeof(source_refs)='array' AND jsonb_array_length(source_refs) BETWEEN 1 AND 64 AND octet_length(source_refs::text)<=65536),
  context_features jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context_features)='object' AND octet_length(context_features::text)<=16384),
  measured_metrics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(measured_metrics)='object' AND octet_length(measured_metrics::text)<=8192),
  occurred_at timestamptz NOT NULL,
  observation_hash text NOT NULL CHECK (observation_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (workforce_assignment_id),
  UNIQUE (tenant_id,observation_hash),
  FOREIGN KEY (tenant_id,agent_profile_id) REFERENCES finnor_os.agent_profiles(tenant_id,id),
  FOREIGN KEY (tenant_id,agent_revision_id) REFERENCES finnor_os.agent_profile_revisions(tenant_id,id),
  FOREIGN KEY (tenant_id,workforce_assignment_id) REFERENCES finnor_os.workforce_assignments(tenant_id,id),
  FOREIGN KEY (tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
  FOREIGN KEY (tenant_id,work_id,plan_revision_id) REFERENCES finnor_os.work_plan_revisions(tenant_id,work_id,id)
);
CREATE INDEX learning_observations_metric_slice_idx ON finnor_os.learning_observations(tenant_id,agent_revision_id,capability,node_kind,context_class,occurred_at DESC);

CREATE TABLE finnor_os.learning_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  target_type text NOT NULL CHECK (target_type IN ('agent_profile','agent_capability')),
  target_id uuid NOT NULL,
  target_agent_revision_id uuid NOT NULL,
  capability text,
  evidence_window jsonb NOT NULL CHECK (jsonb_typeof(evidence_window)='object' AND evidence_window ?& ARRAY['from','to']),
  sample_size integer NOT NULL CHECK (sample_size BETWEEN 5 AND 10000),
  observation_refs jsonb NOT NULL CHECK (jsonb_typeof(observation_refs)='array' AND jsonb_array_length(observation_refs)=sample_size AND octet_length(observation_refs::text)<=262144),
  proposed_change jsonb NOT NULL CHECK (jsonb_typeof(proposed_change)='object' AND octet_length(proposed_change::text)<=32768),
  confidence_class text NOT NULL CHECK (confidence_class IN ('SUPPORTED','STRONG')),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','promoted')),
  proposal_hash text NOT NULL CHECK (proposal_hash ~ '^sha256:[0-9a-f]{64}$'),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,proposal_hash),
  FOREIGN KEY (tenant_id,target_id) REFERENCES finnor_os.agent_profiles(tenant_id,id),
  FOREIGN KEY (tenant_id,target_agent_revision_id) REFERENCES finnor_os.agent_profile_revisions(tenant_id,id),
  FOREIGN KEY (tenant_id,reviewed_by) REFERENCES finnor_os.users(tenant_id,id),
  CHECK ((reviewed_by IS NULL)=(reviewed_at IS NULL)),
  CHECK ((status='proposed')=(reviewed_by IS NULL))
);
CREATE INDEX learning_proposals_tenant_status_idx ON finnor_os.learning_proposals(tenant_id,status,created_at DESC);
ALTER TABLE finnor_os.learning_revisions
  ADD CONSTRAINT learning_revisions_source_proposal_fkey FOREIGN KEY (tenant_id,source_proposal_id)
  REFERENCES finnor_os.learning_proposals(tenant_id,id);

CREATE OR REPLACE FUNCTION finnor_os.assert_nonhuman_agent_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM finnor_os.users WHERE id=NEW.id) THEN
    RAISE EXCEPTION 'AI AgentProfile identity cannot equal a human user identity';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_profile_nonhuman BEFORE INSERT OR UPDATE OF id ON finnor_os.agent_profiles
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_nonhuman_agent_identity();

CREATE OR REPLACE FUNCTION finnor_os.assert_human_not_agent_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM finnor_os.agent_profiles WHERE id=NEW.id) THEN
    RAISE EXCEPTION 'human user identity cannot equal an AI AgentProfile identity';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_not_agent_identity BEFORE INSERT OR UPDATE OF id ON finnor_os.users
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_human_not_agent_identity();

CREATE OR REPLACE FUNCTION finnor_os.assert_agent_profile_revision_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE profile_tenant uuid; learning_tenant uuid; learning_profile uuid; grant_count integer; distinct_grant_count integer;
BEGIN
  SELECT tenant_id INTO profile_tenant FROM finnor_os.agent_profiles WHERE id=NEW.agent_profile_id;
  IF profile_tenant IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'AgentProfileRevision profile tenant mismatch'; END IF;
  IF NEW.learning_revision_id IS NOT NULL THEN
    SELECT tenant_id,target_agent_profile_id INTO learning_tenant,learning_profile FROM finnor_os.learning_revisions WHERE id=NEW.learning_revision_id;
    IF learning_tenant IS DISTINCT FROM NEW.tenant_id OR learning_profile IS DISTINCT FROM NEW.agent_profile_id THEN
      RAISE EXCEPTION 'AgentProfileRevision learning revision scope mismatch';
    END IF;
  END IF;
  SELECT count(*),count(DISTINCT (value->>'kind')||':'||(value->>'capability'))
    INTO grant_count,distinct_grant_count FROM jsonb_array_elements(NEW.capability_grants);
  IF grant_count<>distinct_grant_count OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.capability_grants) grant_item
    WHERE jsonb_typeof(grant_item)<>'object' OR grant_item->>'kind' NOT IN ('query','action','wait','check')
      OR length(coalesce(grant_item->>'capability','')) NOT BETWEEN 1 AND 240
      OR grant_item - ARRAY['kind','capability']::text[] <> '{}'::jsonb
  ) THEN RAISE EXCEPTION 'Agent capability grants must be unique exact P6/Core capability references'; END IF;
  IF NEW.planning_hints::text ~* '(authority|policy|human.?only|vote|attest|approve|schema|compiler|evidence|business.?effect|source.?truth)' THEN
    RAISE EXCEPTION 'Agent planning hints cannot encode hard authority, truth, or compiler changes';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_profile_revisions_scope BEFORE INSERT ON finnor_os.agent_profile_revisions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_agent_profile_revision_scope();

CREATE OR REPLACE FUNCTION finnor_os.guard_agent_profile_revision_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AgentProfileRevisions are immutable history'; END IF;
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.agent_profile_id IS DISTINCT FROM NEW.agent_profile_id
    OR OLD.revision IS DISTINCT FROM NEW.revision OR OLD.model_route IS DISTINCT FROM NEW.model_route
    OR OLD.capability_grants IS DISTINCT FROM NEW.capability_grants OR OLD.max_concurrent_assignments IS DISTINCT FROM NEW.max_concurrent_assignments
    OR OLD.autonomy_limits IS DISTINCT FROM NEW.autonomy_limits OR OLD.planning_hints IS DISTINCT FROM NEW.planning_hints
    OR OLD.learning_revision_id IS DISTINCT FROM NEW.learning_revision_id OR OLD.config_hash IS DISTINCT FROM NEW.config_hash
    OR OLD.created_by IS DISTINCT FROM NEW.created_by OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'AgentProfileRevision semantic configuration is immutable';
  END IF;
  IF OLD.status<>'active' OR NEW.status NOT IN ('superseded','disabled') THEN RAISE EXCEPTION 'invalid AgentProfileRevision status transition'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_profile_revisions_immutable BEFORE UPDATE OR DELETE ON finnor_os.agent_profile_revisions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_agent_profile_revision_mutation();

CREATE OR REPLACE FUNCTION finnor_os.assert_workforce_assignment_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE selected_graph jsonb; plan_status text; node jsonb; expected_capability text; profile_tenant uuid; profile_status text; revision_tenant uuid; revision_profile uuid; revision_status text; grants jsonb; loop_work uuid; step_work uuid; step_plan uuid; step_node text; prior_plan uuid; prior_node text; prior_state text; action_plan uuid; action_node text;
BEGIN
  SELECT revision.plan_graph,revision.status INTO selected_graph,plan_status FROM finnor_os.work_plan_revisions revision
    WHERE tenant_id=NEW.tenant_id AND work_id=NEW.work_id AND id=NEW.plan_revision_id;
  SELECT value INTO node FROM jsonb_array_elements(coalesce(selected_graph->'nodes','[]'::jsonb)) WHERE value->>'id'=NEW.plan_node_id LIMIT 1;
  expected_capability := CASE node->>'kind'
    WHEN 'action' THEN node->>'actionType'
    WHEN 'query' THEN 'query:'||(node->'request'->>'intent')
    WHEN 'wait' THEN 'wait:event'
    WHEN 'check' THEN 'check:objective_success'
    ELSE NULL END;
  IF node IS NULL OR node->>'kind' IS DISTINCT FROM NEW.node_kind OR expected_capability IS DISTINCT FROM NEW.capability THEN
    RAISE EXCEPTION 'WorkforceAssignment must exactly bind one selected P6 PlanNode capability';
  END IF;
  IF NEW.capability = ANY(ARRAY['configure_ic_committee','record_ic_vote','cast_ic_vote','record_ic_dissent','waive_ic_question','waive_ic_condition','open_ic_voting','close_ic_voting','finalize_ic_decision','waive_closing_condition','verify_closing_item']) THEN
    RAISE EXCEPTION 'AI workers cannot claim a human-only capability';
  END IF;
  SELECT tenant_id,status INTO profile_tenant,profile_status FROM finnor_os.agent_profiles WHERE id=NEW.agent_profile_id;
  SELECT tenant_id,agent_profile_id,status,capability_grants INTO revision_tenant,revision_profile,revision_status,grants
    FROM finnor_os.agent_profile_revisions WHERE id=NEW.agent_revision_id;
  IF profile_tenant IS DISTINCT FROM NEW.tenant_id OR revision_tenant IS DISTINCT FROM NEW.tenant_id OR revision_profile IS DISTINCT FROM NEW.agent_profile_id THEN
    RAISE EXCEPTION 'WorkforceAssignment agent scope mismatch';
  END IF;
  IF TG_OP='INSERT' AND (profile_status<>'enabled' OR revision_status<>'active') THEN RAISE EXCEPTION 'WorkforceAssignment requires an enabled profile and active exact revision'; END IF;
  IF NOT grants @> jsonb_build_array(jsonb_build_object('capability',NEW.capability,'kind',NEW.node_kind)) THEN
    RAISE EXCEPTION 'AgentProfileRevision does not grant this exact PlanNode capability';
  END IF;
  IF NEW.state IN ('queued','claimed','running','waiting') AND plan_status<>'active' THEN RAISE EXCEPTION 'active assignment cannot reference a superseded PlanRevision'; END IF;
  IF NEW.objective_loop_id IS NOT NULL THEN
    SELECT work_id INTO loop_work FROM finnor_os.work_objective_loops WHERE tenant_id=NEW.tenant_id AND id=NEW.objective_loop_id;
    IF loop_work IS DISTINCT FROM NEW.work_id THEN RAISE EXCEPTION 'WorkforceAssignment ObjectiveLoop scope mismatch'; END IF;
  END IF;
  IF NEW.objective_step_id IS NOT NULL THEN
    SELECT work_id,plan_revision_id,plan_node_id INTO step_work,step_plan,step_node FROM finnor_os.work_objective_steps WHERE tenant_id=NEW.tenant_id AND id=NEW.objective_step_id;
    IF step_work IS DISTINCT FROM NEW.work_id OR step_plan IS DISTINCT FROM NEW.plan_revision_id OR step_node IS DISTINCT FROM NEW.plan_node_id THEN
      RAISE EXCEPTION 'WorkforceAssignment ObjectiveStep scope mismatch';
    END IF;
  END IF;
  IF NEW.previous_assignment_id IS NOT NULL THEN
    SELECT plan_revision_id,plan_node_id,state INTO prior_plan,prior_node,prior_state FROM finnor_os.workforce_assignments WHERE tenant_id=NEW.tenant_id AND id=NEW.previous_assignment_id;
    IF prior_plan IS DISTINCT FROM NEW.plan_revision_id OR prior_node IS DISTINCT FROM NEW.plan_node_id OR prior_state NOT IN ('failed','cancelled','reassigned') THEN
      RAISE EXCEPTION 'Workforce reassignment must preserve exact node history from a terminal prior owner';
    END IF;
  END IF;
  IF NEW.domain_action_id IS NOT NULL THEN
    SELECT plan_revision_id,plan_node_id INTO action_plan,action_node FROM finnor_os.domain_actions WHERE tenant_id=NEW.tenant_id AND id=NEW.domain_action_id;
    IF action_plan IS DISTINCT FROM NEW.plan_revision_id OR action_node IS DISTINCT FROM NEW.plan_node_id THEN RAISE EXCEPTION 'WorkforceAssignment DomainAction scope mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workforce_assignments_scope BEFORE INSERT OR UPDATE OF tenant_id,work_id,plan_revision_id,plan_node_id,objective_loop_id,objective_step_id,agent_profile_id,agent_revision_id,capability,node_kind,state,previous_assignment_id,domain_action_id ON finnor_os.workforce_assignments
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_workforce_assignment_scope();

CREATE OR REPLACE FUNCTION finnor_os.guard_workforce_assignment_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'WorkforceAssignment history cannot be deleted'; END IF;
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.work_id IS DISTINCT FROM NEW.work_id OR OLD.plan_revision_id IS DISTINCT FROM NEW.plan_revision_id
    OR OLD.plan_node_id IS DISTINCT FROM NEW.plan_node_id OR OLD.objective_loop_id IS DISTINCT FROM NEW.objective_loop_id OR OLD.objective_step_id IS DISTINCT FROM NEW.objective_step_id
    OR OLD.agent_profile_id IS DISTINCT FROM NEW.agent_profile_id OR OLD.agent_revision_id IS DISTINCT FROM NEW.agent_revision_id
    OR OLD.capability IS DISTINCT FROM NEW.capability OR OLD.node_kind IS DISTINCT FROM NEW.node_kind OR OLD.budget_snapshot IS DISTINCT FROM NEW.budget_snapshot
    OR OLD.assignment_reason IS DISTINCT FROM NEW.assignment_reason OR OLD.assignment_score IS DISTINCT FROM NEW.assignment_score
    OR OLD.previous_assignment_id IS DISTINCT FROM NEW.previous_assignment_id OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'WorkforceAssignment ownership identity is immutable';
  END IF;
  IF OLD.state IN ('completed','failed','cancelled','reassigned') THEN RAISE EXCEPTION 'terminal WorkforceAssignment is immutable'; END IF;
  IF NOT ((OLD.state='queued' AND NEW.state IN ('queued','claimed','failed','cancelled','reassigned'))
    OR (OLD.state='claimed' AND NEW.state IN ('claimed','queued','running','failed','cancelled','reassigned'))
    OR (OLD.state='running' AND NEW.state IN ('running','waiting','completed','failed','cancelled','reassigned'))
    OR (OLD.state='waiting' AND NEW.state IN ('waiting','queued','completed','failed','cancelled','reassigned'))) THEN
    RAISE EXCEPTION 'invalid WorkforceAssignment state transition';
  END IF;
  IF NEW.attempt<OLD.attempt OR NEW.attempt>OLD.attempt+1 THEN RAISE EXCEPTION 'invalid WorkforceAssignment attempt transition'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workforce_assignments_history BEFORE UPDATE OR DELETE ON finnor_os.workforce_assignments
  FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_workforce_assignment_mutation();

CREATE OR REPLACE FUNCTION finnor_os.assert_learning_observation_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE assignment finnor_os.workforce_assignments%ROWTYPE; durable_success boolean;
BEGIN
  SELECT * INTO assignment FROM finnor_os.workforce_assignments WHERE tenant_id=NEW.tenant_id AND id=NEW.workforce_assignment_id;
  IF assignment.id IS NULL OR assignment.state NOT IN ('completed','failed','cancelled','reassigned')
    OR assignment.agent_profile_id IS DISTINCT FROM NEW.agent_profile_id OR assignment.agent_revision_id IS DISTINCT FROM NEW.agent_revision_id
    OR assignment.capability IS DISTINCT FROM NEW.capability OR assignment.node_kind IS DISTINCT FROM NEW.node_kind
    OR assignment.work_id IS DISTINCT FROM NEW.work_id OR assignment.plan_revision_id IS DISTINCT FROM NEW.plan_revision_id OR assignment.plan_node_id IS DISTINCT FROM NEW.plan_node_id THEN
    RAISE EXCEPTION 'LearningObservation must pin one exact terminal WorkforceAssignment';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.source_refs) source_ref
    WHERE jsonb_typeof(source_ref)<>'object'
      OR source_ref->>'type' NOT IN ('completion_proof','business_effect','decision_receipt','domain_action','plan_node','objective_step','query_execution','work_event_wait','replan','human_decision','provider_event','attention_item')
      OR length(coalesce(source_ref->>'id','')) NOT BETWEEN 1 AND 240
      OR source_ref - ARRAY['type','id','hash']::text[] <> '{}'::jsonb
  ) OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.source_refs) source_ref
    WHERE source_ref->>'type'='objective_step' AND source_ref->>'id'=assignment.objective_step_id::text
  ) OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.source_refs) source_ref
    WHERE source_ref->>'type'='plan_node' AND source_ref->>'id'=assignment.plan_node_id
  ) THEN RAISE EXCEPTION 'LearningObservation source references must include the exact ObjectiveStep and PlanNode'; END IF;
  IF NEW.outcome_class='verified_completion' AND NOT NEW.verified THEN RAISE EXCEPTION 'unverified completion cannot be classified as verified learning'; END IF;
  IF NEW.outcome_class='verified_completion' THEN
    SELECT (
      EXISTS (SELECT 1 FROM finnor_os.work_plan_revisions plan WHERE plan.tenant_id=NEW.tenant_id AND plan.id=assignment.plan_revision_id AND plan.completion_proof->>'verified'='true')
      OR EXISTS (SELECT 1 FROM finnor_os.work_objective_steps step JOIN finnor_os.work_query_executions query ON query.id=step.query_execution_id AND query.tenant_id=step.tenant_id
                 WHERE step.tenant_id=NEW.tenant_id AND step.id=assignment.objective_step_id AND query.status='succeeded')
      OR EXISTS (SELECT 1 FROM finnor_os.domain_actions action WHERE action.tenant_id=NEW.tenant_id AND action.id=assignment.domain_action_id AND action.status='completed')
      OR EXISTS (SELECT 1 FROM finnor_os.business_effects effect WHERE effect.tenant_id=NEW.tenant_id AND effect.domain_action_id=assignment.domain_action_id AND effect.status='verified')
      OR EXISTS (SELECT 1 FROM finnor_os.work_event_waits event_wait WHERE event_wait.tenant_id=NEW.tenant_id AND event_wait.objective_step_id=assignment.objective_step_id AND event_wait.status='satisfied' AND event_wait.matched_event_id IS NOT NULL)
    ) INTO durable_success;
    IF NOT coalesce(durable_success,false) THEN RAISE EXCEPTION 'verified completion requires durable P6/Core completion evidence'; END IF;
  END IF;
  IF NEW.context_features::text ~* '(chain.?of.?thought|self.?rating|authority|policy|human.?only)' THEN RAISE EXCEPTION 'LearningObservation contains prohibited self-evaluation or authority material'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER learning_observations_scope BEFORE INSERT ON finnor_os.learning_observations
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_learning_observation_scope();
CREATE OR REPLACE FUNCTION finnor_os.reject_workforce_history_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  RAISE EXCEPTION 'P7 immutable workforce/learning history cannot be changed or deleted';
END $$;
CREATE TRIGGER learning_observations_immutable BEFORE UPDATE OR DELETE ON finnor_os.learning_observations
  FOR EACH ROW EXECUTE FUNCTION finnor_os.reject_workforce_history_mutation();

CREATE OR REPLACE FUNCTION finnor_os.assert_learning_proposal() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE profile_id uuid; evidence_count integer; verified_count integer; distinct_count integer; observed_from timestamptz; observed_to timestamptz; change_keys text[];
BEGIN
  SELECT agent_profile_id INTO profile_id FROM finnor_os.agent_profile_revisions WHERE tenant_id=NEW.tenant_id AND id=NEW.target_agent_revision_id;
  IF profile_id IS DISTINCT FROM NEW.target_id THEN RAISE EXCEPTION 'LearningProposal target scope mismatch'; END IF;
  SELECT count(*),count(*) FILTER (WHERE observation.verified),count(DISTINCT observation.id),min(observation.occurred_at),max(observation.occurred_at)
    INTO evidence_count,verified_count,distinct_count,observed_from,observed_to
    FROM jsonb_array_elements_text(NEW.observation_refs) ref
    JOIN finnor_os.learning_observations observation ON observation.tenant_id=NEW.tenant_id AND observation.id=ref::uuid
    WHERE observation.agent_revision_id=NEW.target_agent_revision_id
      AND (NEW.capability IS NULL OR observation.capability=NEW.capability);
  IF evidence_count<>NEW.sample_size OR verified_count<>NEW.sample_size OR distinct_count<>NEW.sample_size THEN RAISE EXCEPTION 'LearningProposal evidence must be exact, distinct, verified, same-tenant observations'; END IF;
  IF (NEW.evidence_window->>'from')::timestamptz IS DISTINCT FROM observed_from
    OR (NEW.evidence_window->>'to')::timestamptz IS DISTINCT FROM observed_to THEN
    RAISE EXCEPTION 'LearningProposal evidence window must equal its exact observation range';
  END IF;
  IF NEW.proposed_change->>'class' NOT IN ('routing_preference_adjustment','capability_quality_warning','deprioritize_worker_recommendation','soft_planning_hint_update','model_route_recommendation') THEN
    RAISE EXCEPTION 'LearningProposal class is not permitted';
  END IF;
  SELECT array_agg(key ORDER BY key) INTO change_keys FROM jsonb_object_keys(NEW.proposed_change) key;
  IF (NEW.proposed_change->>'class'='routing_preference_adjustment' AND change_keys<>ARRAY['adjustment','capability','class','weight'])
    OR (NEW.proposed_change->>'class'='capability_quality_warning' AND change_keys<>ARRAY['capability','class','warning'])
    OR (NEW.proposed_change->>'class'='deprioritize_worker_recommendation' AND change_keys<>ARRAY['capability','class','reason'])
    OR (NEW.proposed_change->>'class'='soft_planning_hint_update' AND change_keys<>ARRAY['class','hint','hintKey'])
    OR (NEW.proposed_change->>'class'='model_route_recommendation' AND change_keys NOT IN (ARRAY['capability','class','provider'],ARRAY['capability','class','model','provider'])) THEN
    RAISE EXCEPTION 'LearningProposal body is outside its exact safe class schema';
  END IF;
  IF NEW.proposed_change::text ~* '(authority|policy|human.?only|vote|attest|approve|schema|compiler|evidence|business.?effect|recovery.?guarantee|source.?truth|code|prompt|database)' THEN
    RAISE EXCEPTION 'LearningProposal attempts to modify a hard boundary';
  END IF;
  IF NEW.proposed_change->>'class'='routing_preference_adjustment'
    AND abs((NEW.proposed_change->>'weight')::numeric)>0.25 THEN RAISE EXCEPTION 'Learning routing adjustment exceeds its soft bound'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER learning_proposals_valid BEFORE INSERT ON finnor_os.learning_proposals
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_learning_proposal();

CREATE OR REPLACE FUNCTION finnor_os.guard_learning_proposal_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'LearningProposal history cannot be deleted'; END IF;
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.target_type IS DISTINCT FROM NEW.target_type OR OLD.target_id IS DISTINCT FROM NEW.target_id
    OR OLD.target_agent_revision_id IS DISTINCT FROM NEW.target_agent_revision_id OR OLD.capability IS DISTINCT FROM NEW.capability
    OR OLD.evidence_window IS DISTINCT FROM NEW.evidence_window OR OLD.sample_size IS DISTINCT FROM NEW.sample_size OR OLD.observation_refs IS DISTINCT FROM NEW.observation_refs
    OR OLD.proposed_change IS DISTINCT FROM NEW.proposed_change OR OLD.confidence_class IS DISTINCT FROM NEW.confidence_class
    OR OLD.proposal_hash IS DISTINCT FROM NEW.proposal_hash OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN RAISE EXCEPTION 'LearningProposal evidence/body is immutable'; END IF;
  IF NOT ((OLD.status='proposed' AND NEW.status IN ('approved','rejected')) OR (OLD.status='approved' AND NEW.status='promoted')) THEN
    RAISE EXCEPTION 'invalid LearningProposal review transition';
  END IF;
  IF NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL THEN RAISE EXCEPTION 'LearningProposal transition requires an authenticated human reviewer'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER learning_proposals_history BEFORE UPDATE OR DELETE ON finnor_os.learning_proposals
  FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_learning_proposal_mutation();

CREATE OR REPLACE FUNCTION finnor_os.assert_learning_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE proposal_tenant uuid; proposal_target uuid; proposal_status text; parent_revision integer;
BEGIN
  SELECT tenant_id,target_id,status INTO proposal_tenant,proposal_target,proposal_status FROM finnor_os.learning_proposals WHERE id=NEW.source_proposal_id;
  IF proposal_tenant IS DISTINCT FROM NEW.tenant_id OR proposal_target IS DISTINCT FROM NEW.target_agent_profile_id OR proposal_status<>'approved' THEN
    RAISE EXCEPTION 'LearningRevision requires an approved same-tenant proposal for the same agent';
  END IF;
  IF NEW.parent_revision_id IS NOT NULL THEN
    SELECT revision INTO parent_revision FROM finnor_os.learning_revisions WHERE tenant_id=NEW.tenant_id AND target_agent_profile_id=NEW.target_agent_profile_id AND id=NEW.parent_revision_id;
    IF parent_revision IS NULL OR parent_revision+1<>NEW.revision THEN RAISE EXCEPTION 'LearningRevision must follow its exact immutable parent'; END IF;
  END IF;
  IF NEW.guidance - ARRAY['routingPreferences','capabilityReliabilityPriors','softPlanningHints','modelRoutePreferences','warnings']::text[] <> '{}'::jsonb
    OR NEW.guidance::text ~* '(authority|policy|human.?only|vote|attest|approve|schema|compiler|evidence|business.?effect|recovery.?guarantee|source.?truth)' THEN
    RAISE EXCEPTION 'LearningRevision contains guidance outside the bounded soft contract';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER learning_revisions_valid BEFORE INSERT ON finnor_os.learning_revisions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_learning_revision();
CREATE TRIGGER learning_revisions_immutable BEFORE UPDATE OR DELETE ON finnor_os.learning_revisions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.reject_workforce_history_mutation();

CREATE OR REPLACE FUNCTION finnor_os.cancel_stale_workforce_assignments() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF OLD.status='active' AND NEW.status IN ('superseded','blocked','failed') THEN
    UPDATE finnor_os.workforce_assignments SET state='cancelled',completed_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL,
      failure=jsonb_build_object('code','PLAN_SUPERSEDED','planRevisionId',NEW.id),updated_at=clock_timestamp()
      WHERE tenant_id=NEW.tenant_id AND plan_revision_id=NEW.id AND state IN ('queued','claimed','running','waiting');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER work_plan_revision_cancel_assignments AFTER UPDATE OF status ON finnor_os.work_plan_revisions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.cancel_stale_workforce_assignments();

CREATE OR REPLACE FUNCTION finnor_os.relinquish_disabled_agent_assignments() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF (TG_TABLE_NAME='agent_profiles' AND OLD.status='enabled' AND NEW.status='disabled') THEN
    UPDATE finnor_os.workforce_assignments SET state='reassigned',completed_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL,
      reassignment_reason='AGENT_DISABLED',failure=jsonb_build_object('code','AGENT_DISABLED'),updated_at=clock_timestamp()
      WHERE tenant_id=NEW.tenant_id AND agent_profile_id=NEW.id AND state IN ('queued','claimed','running','waiting');
  ELSIF (TG_TABLE_NAME='agent_profile_revisions' AND OLD.status='active' AND NEW.status<>'active') THEN
    UPDATE finnor_os.workforce_assignments SET state='reassigned',completed_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL,
      reassignment_reason='AGENT_REVISION_SUPERSEDED',failure=jsonb_build_object('code','AGENT_REVISION_SUPERSEDED'),updated_at=clock_timestamp()
      WHERE tenant_id=NEW.tenant_id AND agent_revision_id=NEW.id AND state IN ('queued','claimed','running','waiting');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_profile_relinquish_assignments AFTER UPDATE OF status ON finnor_os.agent_profiles
  FOR EACH ROW EXECUTE FUNCTION finnor_os.relinquish_disabled_agent_assignments();
CREATE TRIGGER agent_revision_relinquish_assignments AFTER UPDATE OF status ON finnor_os.agent_profile_revisions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.relinquish_disabled_agent_assignments();

ALTER TABLE finnor_os.agent_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.agent_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.agent_profile_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.agent_profile_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.workforce_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.workforce_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.learning_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.learning_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.learning_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.learning_proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.learning_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.learning_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finnor_os.agent_profiles USING (tenant_id=(SELECT finnor_os.request_tenant_id())) WITH CHECK (tenant_id=(SELECT finnor_os.request_tenant_id()));
CREATE POLICY tenant_isolation ON finnor_os.agent_profile_revisions USING (tenant_id=(SELECT finnor_os.request_tenant_id())) WITH CHECK (tenant_id=(SELECT finnor_os.request_tenant_id()));
CREATE POLICY tenant_isolation ON finnor_os.workforce_assignments USING (tenant_id=(SELECT finnor_os.request_tenant_id())) WITH CHECK (tenant_id=(SELECT finnor_os.request_tenant_id()));
CREATE POLICY tenant_isolation ON finnor_os.learning_observations USING (tenant_id=(SELECT finnor_os.request_tenant_id())) WITH CHECK (tenant_id=(SELECT finnor_os.request_tenant_id()));
CREATE POLICY tenant_isolation ON finnor_os.learning_proposals USING (tenant_id=(SELECT finnor_os.request_tenant_id())) WITH CHECK (tenant_id=(SELECT finnor_os.request_tenant_id()));
CREATE POLICY tenant_isolation ON finnor_os.learning_revisions USING (tenant_id=(SELECT finnor_os.request_tenant_id())) WITH CHECK (tenant_id=(SELECT finnor_os.request_tenant_id()));

DO $p7_permissions$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    GRANT SELECT,INSERT,UPDATE(name,status) ON finnor_os.agent_profiles TO finnor_app;
    GRANT SELECT,INSERT,UPDATE(status) ON finnor_os.agent_profile_revisions TO finnor_app;
    GRANT SELECT,INSERT,UPDATE(state,attempt,lease_owner,lease_until,reassignment_reason,domain_action_id,started_at,completed_at,failure,updated_at) ON finnor_os.workforce_assignments TO finnor_app;
    GRANT SELECT,INSERT ON finnor_os.learning_observations TO finnor_app;
    GRANT SELECT,INSERT,UPDATE(status,reviewed_by,reviewed_at) ON finnor_os.learning_proposals TO finnor_app;
    GRANT SELECT,INSERT ON finnor_os.learning_revisions TO finnor_app;
    REVOKE DELETE ON finnor_os.agent_profiles,finnor_os.agent_profile_revisions,finnor_os.workforce_assignments,finnor_os.learning_observations,finnor_os.learning_proposals,finnor_os.learning_revisions FROM finnor_app;
  END IF;
END $p7_permissions$;

INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required)
SELECT role.tenant_id,role.id,grant_row.capability,grant_row.resource_type,'allow','medium',false
FROM finnor_os.employee_roles role
CROSS JOIN (VALUES
  ('workforce:configure_agent','agent_profile'),
  ('workforce:promote_learning','learning_proposal'),
  ('workforce:reassign_agent','workforce_assignment')
) grant_row(capability,resource_type)
WHERE role.legacy_role='owner'
ON CONFLICT(role_id,capability,resource_type) DO NOTHING;
CREATE OR REPLACE FUNCTION finnor_os.sync_workforce_owner_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF NEW.legacy_role='owner' THEN
    INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required)
    VALUES
      (NEW.tenant_id,NEW.id,'workforce:configure_agent','agent_profile','allow','medium',false),
      (NEW.tenant_id,NEW.id,'workforce:promote_learning','learning_proposal','allow','medium',false),
      (NEW.tenant_id,NEW.id,'workforce:reassign_agent','workforce_assignment','allow','medium',false)
    ON CONFLICT(role_id,capability,resource_type) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employee_roles_workforce_owner_authority AFTER INSERT OR UPDATE OF legacy_role ON finnor_os.employee_roles
  FOR EACH ROW EXECUTE FUNCTION finnor_os.sync_workforce_owner_authority();

COMMENT ON TABLE finnor_os.agent_profiles IS 'P7 non-human worker identities; deliberately never human principals or authority holders.';
COMMENT ON TABLE finnor_os.agent_profile_revisions IS 'Immutable P7 worker configuration pinned by every assignment.';
COMMENT ON TABLE finnor_os.workforce_assignments IS 'Lease/history for who owns one P6-ready PlanNode; never duplicate PlanNode execution truth.';
COMMENT ON TABLE finnor_os.learning_observations IS 'Immutable source-pinned outcomes; no chain-of-thought or self-evaluation.';
COMMENT ON TABLE finnor_os.learning_proposals IS 'Human-reviewable bounded soft changes; cannot modify hard authority/truth/compiler semantics.';
COMMENT ON TABLE finnor_os.learning_revisions IS 'Immutable promoted soft workforce guidance; historical AgentProfileRevisions pin exact revisions.';
