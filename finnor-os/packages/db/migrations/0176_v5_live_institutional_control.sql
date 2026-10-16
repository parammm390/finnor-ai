-- V5 is a control/projection record, never a financial, authority or effect owner.
-- No capacity, professional qualification, admission or live authority is seeded.
CREATE FUNCTION finnor_os.may_query_resource(p_type text,p_id text,p_capability text DEFAULT 'query:pe_world_state')
RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,finnor_os AS $$
 WITH scoped AS (
  SELECT g.effect,g.approval_required,g.max_risk
   FROM finnor_os.users u
   JOIN finnor_os.employee_role_assignments a ON a.tenant_id=u.tenant_id AND a.employee_id=u.id
   JOIN finnor_os.employee_roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id AND r.active
   JOIN finnor_os.role_authority_grants g ON g.tenant_id=a.tenant_id AND g.role_id=a.role_id
  WHERE u.tenant_id=finnor_os.request_tenant_id()
    AND u.id=nullif(current_setting('app.user_id',true),'')::uuid AND u.status='active' AND u.role='owner'
    AND a.active AND a.effective_from<=clock_timestamp() AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp())
    AND (g.capability='*' OR g.capability=p_capability OR
      (right(g.capability,2)=':*' AND left(p_capability,length(g.capability)-1)=left(g.capability,length(g.capability)-1)))
    AND (g.resource_type='*' OR g.resource_type=p_type)
    AND CASE a.resource_scope->>'kind'
      WHEN 'tenant' THEN true
      WHEN 'resources' THEN
        (a.resource_scope->>'resourceType' IS NULL OR a.resource_scope->>'resourceType'='*' OR a.resource_scope->>'resourceType'=p_type)
        AND coalesce(a.resource_scope->'resourceIds' ? p_id,false)
      WHEN 'self' THEN p_type IN('user','employee') AND p_id=u.id::text
      WHEN 'assigned' THEN
        (p_type IN('user','employee') AND p_id=u.id::text) OR
        (p_type='work' AND EXISTS(SELECT 1 FROM finnor_os.works w
          WHERE w.tenant_id=u.tenant_id AND w.id::text=p_id AND (w.assigned_to=u.id OR w.current_owner_id=u.id)))
      ELSE false END
 )
 SELECT p_type IS NOT NULL AND p_id IS NOT NULL AND p_type<>'*'
   AND (p_type<>'p4_derivation' OR EXISTS(SELECT 1 FROM finnor_os.p4_derivations d
     WHERE d.tenant_id=finnor_os.request_tenant_id() AND d.id::text=p_id
       AND d.principal_id=nullif(current_setting('app.user_id',true),'')::uuid))
   AND EXISTS(SELECT 1 FROM scoped WHERE effect='allow' AND NOT approval_required AND max_risk IN('low','medium','high','critical'))
   AND NOT EXISTS(SELECT 1 FROM scoped WHERE effect='deny')
$$;
REVOKE ALL ON FUNCTION finnor_os.may_query_resource(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.may_query_resource(text,text,text) TO finnor_app;

CREATE FUNCTION finnor_os.v5_resources_visible(resources jsonb) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,finnor_os AS $$
 SELECT CASE WHEN jsonb_typeof(resources)<>'array' THEN false
  WHEN jsonb_array_length(resources) NOT BETWEEN 1 AND 512 THEN false
  ELSE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(resources) r
    WHERE NOT coalesce(finnor_os.may_query_resource(r->>'type',r->>'id',
      CASE WHEN r->>'type'='allocation_resource' THEN 'query:allocation_resources' ELSE 'query:pe_world_state' END),false)) END
$$;
REVOKE ALL ON FUNCTION finnor_os.v5_resources_visible(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.v5_resources_visible(jsonb) TO finnor_app;

-- Security owns verified session lifetime. Ending delivery never cancels effects.
CREATE TABLE finnor_os.auth_delivery_sessions (
 tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
 session_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 256),
 expires_at timestamptz NOT NULL, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,session_id)
);
ALTER TABLE finnor_os.auth_delivery_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.auth_delivery_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_principal ON finnor_os.auth_delivery_sessions
 USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON finnor_os.auth_delivery_sessions TO finnor_app;

-- Actor classification is explicit identity configuration, not a browser role.
-- An agent's assignment is an existing S1 grant; operational delegation is lineage.
CREATE TABLE finnor_os.employee_actor_profiles (
 tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
 principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 actor_kind text NOT NULL CHECK(actor_kind IN('HUMAN','AGENT','SERVICE')),
 delegated_by uuid REFERENCES finnor_os.users(id),
 authority_assignment_id uuid REFERENCES finnor_os.employee_role_assignments(id),
 delegation_id uuid REFERENCES finnor_os.delegations(id),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,principal_id),
 CHECK(actor_kind<>'AGENT' OR (delegated_by IS NOT NULL AND authority_assignment_id IS NOT NULL AND delegation_id IS NOT NULL))
);
ALTER TABLE finnor_os.employee_actor_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.employee_actor_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY actor_read ON finnor_os.employee_actor_profiles FOR SELECT
 USING(tenant_id=finnor_os.request_tenant_id() AND
  (principal_id=nullif(current_setting('app.user_id',true),'')::uuid OR finnor_os.may_query_resource('user',principal_id::text)));
GRANT SELECT ON finnor_os.employee_actor_profiles TO finnor_app;
CREATE FUNCTION finnor_os.v5_actor_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,finnor_os AS $$
 BEGIN
  UPDATE finnor_os.authority_states SET revision=revision+1,updated_at=clock_timestamp()
   WHERE tenant_id=CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  RETURN NULL;
 END $$;
REVOKE ALL ON FUNCTION finnor_os.v5_actor_revision() FROM PUBLIC;
CREATE TRIGGER actor_revision AFTER INSERT OR UPDATE OR DELETE ON finnor_os.employee_actor_profiles
 FOR EACH ROW EXECUTE FUNCTION finnor_os.v5_actor_revision();
-- Org/delegation mutation invalidates current views; it grants no permission.
CREATE TRIGGER v5_org_membership_revision AFTER INSERT OR UPDATE OR DELETE ON finnor_os.org_unit_memberships
 FOR EACH ROW EXECUTE FUNCTION finnor_os.v5_actor_revision();
CREATE TRIGGER v5_delegation_revision AFTER INSERT OR UPDATE OR DELETE ON finnor_os.delegations
 FOR EACH ROW EXECUTE FUNCTION finnor_os.v5_actor_revision();

CREATE TABLE finnor_os.v5_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
 work_id uuid NOT NULL REFERENCES finnor_os.works(id),root jsonb NOT NULL,focus jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES finnor_os.users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,work_id,root,focus),UNIQUE(tenant_id,id)
);
ALTER TABLE finnor_os.v5_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.v5_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY session_context ON finnor_os.v5_sessions
 USING(tenant_id=finnor_os.request_tenant_id() AND finnor_os.may_query_resource('work',work_id::text)
   AND finnor_os.may_query_resource(root->>'entityType',root->>'entityId')
   AND finnor_os.may_query_resource(focus->>'type',focus->>'id'))
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND created_by=nullif(current_setting('app.user_id',true),'')::uuid
   AND finnor_os.may_query_resource('work',work_id::text)
   AND finnor_os.may_query_resource(root->>'entityType',root->>'entityId')
   AND finnor_os.may_query_resource(focus->>'type',focus->>'id'));
GRANT SELECT,INSERT ON finnor_os.v5_sessions TO finnor_app;
CREATE FUNCTION finnor_os.v5_session_visible(p_session uuid) RETURNS boolean
 LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,finnor_os AS $$
 SELECT EXISTS(SELECT 1 FROM finnor_os.v5_sessions WHERE id=p_session AND tenant_id=finnor_os.request_tenant_id())
$$;
REVOKE ALL ON FUNCTION finnor_os.v5_session_visible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.v5_session_visible(uuid) TO finnor_app;

CREATE TABLE finnor_os.v5_participants (
 tenant_id uuid NOT NULL,session_id uuid NOT NULL,principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 delivery_session_id uuid NOT NULL,joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,session_id,principal_id,delivery_session_id),
 FOREIGN KEY(tenant_id,session_id) REFERENCES finnor_os.v5_sessions(tenant_id,id)
);
ALTER TABLE finnor_os.v5_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.v5_participants FORCE ROW LEVEL SECURITY;
CREATE POLICY participant_context ON finnor_os.v5_participants
 USING(tenant_id=finnor_os.request_tenant_id() AND finnor_os.v5_session_visible(session_id)
   AND (principal_id=nullif(current_setting('app.user_id',true),'')::uuid OR finnor_os.may_query_resource('user',principal_id::text)))
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND finnor_os.v5_session_visible(session_id)
   AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT ON finnor_os.v5_participants TO finnor_app;

CREATE TABLE finnor_os.v5_branches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,session_id uuid NOT NULL,
 principal_id uuid NOT NULL REFERENCES finnor_os.users(id),parent_id uuid,
 visibility text NOT NULL CHECK(visibility IN('PRIVATE','SHARED')),
 current_visibility text NOT NULL DEFAULT 'PRIVATE' CHECK(current_visibility IN('PRIVATE','SHARED')),intent jsonb NOT NULL,
 owner_vector jsonb NOT NULL,resources jsonb NOT NULL,
 intent_digest text NOT NULL CHECK(intent_digest~'^[a-f0-9]{64}$'),
 reason text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,session_id) REFERENCES finnor_os.v5_sessions(tenant_id,id),UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,session_id,id),
 CHECK(jsonb_typeof(resources)='array' AND jsonb_array_length(resources) BETWEEN 1 AND 512),
 CHECK(octet_length(intent::text)<=2097152)
);
-- Original P1/S5 funding references are principal-private even when the exact
-- hypothetical institutional change is shared. A shared branch grants nothing.
CREATE TABLE finnor_os.v5_consequence_grants (
 tenant_id uuid NOT NULL,session_id uuid NOT NULL,branch_id uuid NOT NULL,principal_id uuid NOT NULL,
 grant_body jsonb NOT NULL,PRIMARY KEY(tenant_id,branch_id),
 FOREIGN KEY(tenant_id,session_id,branch_id) REFERENCES finnor_os.v5_branches(tenant_id,session_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
ALTER TABLE finnor_os.v5_consequence_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.v5_consequence_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY private_grant ON finnor_os.v5_consequence_grants
 USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid
  AND EXISTS(SELECT 1 FROM finnor_os.v5_branches b WHERE b.tenant_id=v5_consequence_grants.tenant_id
    AND b.session_id=v5_consequence_grants.session_id AND b.id=v5_consequence_grants.branch_id AND b.principal_id=v5_consequence_grants.principal_id));
GRANT SELECT,INSERT ON finnor_os.v5_consequence_grants TO finnor_app;
CREATE TABLE finnor_os.v5_branch_custody (
 tenant_id uuid NOT NULL,session_id uuid NOT NULL,branch_id uuid NOT NULL,principal_id uuid NOT NULL,
 intent jsonb NOT NULL,intent_digest text NOT NULL,owner_vector jsonb NOT NULL,
 PRIMARY KEY(tenant_id,branch_id),
 FOREIGN KEY(tenant_id,session_id,branch_id) REFERENCES finnor_os.v5_branches(tenant_id,session_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.v5_evaluations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,session_id uuid NOT NULL,
 principal_id uuid NOT NULL,branch_id uuid NOT NULL,request_digest text NOT NULL,owner_vector jsonb NOT NULL,
 status text NOT NULL CHECK(status IN('ACCEPTED','RUNNING','COMPLETE','PARTIAL','FAILED','INVALIDATED','BLOCKED','UNKNOWN')),
 result jsonb,job_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,session_id,branch_id) REFERENCES finnor_os.v5_branches(tenant_id,session_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,session_id,branch_id,id)
);
-- Budget references, physical claim credentials and unredacted producer bytes
-- never become shared scenario data, including through direct RLS reads.
CREATE TABLE finnor_os.v5_evaluation_custody (
 tenant_id uuid NOT NULL,session_id uuid NOT NULL,branch_id uuid NOT NULL,evaluation_id uuid NOT NULL,
 principal_id uuid NOT NULL,delivery_session_id uuid NOT NULL,original_budget jsonb,
 result_private jsonb,cost_refs jsonb NOT NULL DEFAULT '[]',charged boolean NOT NULL DEFAULT false,
 owner_vector jsonb NOT NULL,
 claim_token uuid,claim_fence bigint,PRIMARY KEY(tenant_id,evaluation_id),
 FOREIGN KEY(tenant_id,session_id,branch_id,evaluation_id) REFERENCES finnor_os.v5_evaluations(tenant_id,session_id,branch_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,delivery_session_id) REFERENCES finnor_os.auth_delivery_sessions(tenant_id,session_id)
);
ALTER TABLE finnor_os.v5_evaluation_custody ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.v5_evaluation_custody FORCE ROW LEVEL SECURITY;
CREATE POLICY evaluation_private ON finnor_os.v5_evaluation_custody
 USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON finnor_os.v5_evaluation_custody TO finnor_app;
CREATE TABLE finnor_os.v5_proposals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,session_id uuid NOT NULL,
 principal_id uuid NOT NULL,branch_id uuid NOT NULL,evaluation_id uuid NOT NULL,
 proposal_digest text NOT NULL,request_digest text NOT NULL,owner_vector jsonb NOT NULL,
 native_request jsonb NOT NULL,authority_request jsonb NOT NULL,
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,session_id,branch_id) REFERENCES finnor_os.v5_branches(tenant_id,session_id,id),
 FOREIGN KEY(tenant_id,session_id,branch_id,evaluation_id) REFERENCES finnor_os.v5_evaluations(tenant_id,session_id,branch_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,session_id,id)
);
-- References to S1 decisions, not a second approval owner.
CREATE TABLE finnor_os.v5_approval_refs (
 tenant_id uuid NOT NULL,session_id uuid NOT NULL,proposal_id uuid NOT NULL,
 principal_id uuid NOT NULL,decision_id uuid NOT NULL REFERENCES finnor_os.authority_decisions(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,proposal_id,decision_id),
 FOREIGN KEY(tenant_id,session_id,proposal_id) REFERENCES finnor_os.v5_proposals(tenant_id,session_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.v5_proposal_custody (
 tenant_id uuid NOT NULL,session_id uuid NOT NULL,proposal_id uuid NOT NULL,principal_id uuid NOT NULL,
 native_request jsonb NOT NULL,owner_vector jsonb NOT NULL,proposal_digest text NOT NULL,request_digest text NOT NULL,
 PRIMARY KEY(tenant_id,proposal_id),
 FOREIGN KEY(tenant_id,session_id,proposal_id) REFERENCES finnor_os.v5_proposals(tenant_id,session_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.v5_dispatch_refs (
 tenant_id uuid NOT NULL,session_id uuid NOT NULL,proposal_id uuid NOT NULL,principal_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN('SUBMITTING','OWNER_ACCEPTED','QUEUED','BLOCKED','UNKNOWN','OBSERVED')),
 refs jsonb NOT NULL DEFAULT '{}',reason text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,proposal_id),
 FOREIGN KEY(tenant_id,session_id,proposal_id) REFERENCES finnor_os.v5_proposals(tenant_id,session_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.v5_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,tenant_id uuid NOT NULL,session_id uuid NOT NULL,
 principal_id uuid NOT NULL,branch_id uuid,visibility text NOT NULL CHECK(visibility IN('PRIVATE','SHARED')),
 resources jsonb NOT NULL,kind text NOT NULL,body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,session_id) REFERENCES finnor_os.v5_sessions(tenant_id,id),
 FOREIGN KEY(tenant_id,session_id,branch_id) REFERENCES finnor_os.v5_branches(tenant_id,session_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.v5_dispatch_custody (
 tenant_id uuid NOT NULL,session_id uuid NOT NULL,proposal_id uuid NOT NULL,principal_id uuid NOT NULL,
 refs jsonb NOT NULL DEFAULT '{}',PRIMARY KEY(tenant_id,proposal_id),
 FOREIGN KEY(tenant_id,session_id,proposal_id) REFERENCES finnor_os.v5_proposals(tenant_id,session_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['v5_branch_custody','v5_proposal_custody','v5_dispatch_custody'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY private_custody ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
 END LOOP;
END $$;
GRANT UPDATE ON finnor_os.v5_dispatch_custody TO finnor_app;
CREATE TABLE finnor_os.v5_commands (
 tenant_id uuid NOT NULL,session_id uuid NOT NULL,principal_id uuid NOT NULL,operation text NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),request_digest text NOT NULL,
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,operation,idempotency_key),
 FOREIGN KEY(tenant_id,session_id) REFERENCES finnor_os.v5_sessions(tenant_id,id)
);
-- An opaque recipient/session/query-bound handshake. Sequence numbers and
-- forbidden gaps never cross the API. Polling reconciles the whole permitted
-- owner cut, including commits that arrive out of sequence after a snapshot.
CREATE TABLE finnor_os.v5_cursors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,session_id uuid NOT NULL,
 principal_id uuid NOT NULL,delivery_session_id uuid NOT NULL,projection_digest text NOT NULL,
 owner_vector_digest text NOT NULL,expires_at timestamptz NOT NULL,
 owner_vectors jsonb NOT NULL DEFAULT '{}',
 FOREIGN KEY(tenant_id,session_id) REFERENCES finnor_os.v5_sessions(tenant_id,id)
);

CREATE FUNCTION finnor_os.v5_branch_visible(p_branch uuid) RETURNS boolean
 LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,finnor_os AS $$
 SELECT EXISTS(SELECT 1 FROM finnor_os.v5_branches WHERE id=p_branch AND tenant_id=finnor_os.request_tenant_id())
$$;
REVOKE ALL ON FUNCTION finnor_os.v5_branch_visible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.v5_branch_visible(uuid) TO finnor_app;
-- Current visibility is a derived projection of immutable original/history
-- records. Reading it uses invoker RLS, with no superuser/bypass assumption.
CREATE FUNCTION finnor_os.v5_branch_visibility(p_branch uuid) RETURNS text
 LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,finnor_os AS $$
 SELECT b.current_visibility FROM finnor_os.v5_branches b
 WHERE b.id=p_branch AND b.tenant_id=finnor_os.request_tenant_id()
$$;
REVOKE ALL ON FUNCTION finnor_os.v5_branch_visibility(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.v5_branch_visibility(uuid) TO finnor_app;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['v5_branches','v5_evaluations','v5_proposals','v5_approval_refs','v5_dispatch_refs','v5_history','v5_commands','v5_cursors'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
 END LOOP;
END $$;
CREATE POLICY branch_read ON finnor_os.v5_branches FOR SELECT
 USING(tenant_id=finnor_os.request_tenant_id() AND finnor_os.v5_session_visible(session_id)
  AND (principal_id=nullif(current_setting('app.user_id',true),'')::uuid OR current_visibility='SHARED')
  AND finnor_os.v5_resources_visible(resources));
CREATE POLICY branch_write ON finnor_os.v5_branches FOR INSERT
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND finnor_os.v5_session_visible(session_id)
  AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid AND finnor_os.v5_resources_visible(resources));
CREATE POLICY branch_projection_update ON finnor_os.v5_branches FOR UPDATE
 USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['v5_evaluations','v5_proposals'] LOOP
  EXECUTE format('CREATE POLICY control_read ON finnor_os.%I FOR SELECT USING(tenant_id=finnor_os.request_tenant_id() AND finnor_os.v5_branch_visible(branch_id))',t);
  EXECUTE format('CREATE POLICY control_write ON finnor_os.%1$I FOR INSERT WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid AND EXISTS(SELECT 1 FROM finnor_os.v5_branches b WHERE b.tenant_id=%1$I.tenant_id AND b.session_id=%1$I.session_id AND b.id=%1$I.branch_id AND b.principal_id=%1$I.principal_id))',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['v5_approval_refs','v5_dispatch_refs'] LOOP
  EXECUTE format('CREATE POLICY control_read ON finnor_os.%1$I FOR SELECT USING(tenant_id=finnor_os.request_tenant_id() AND EXISTS(SELECT 1 FROM finnor_os.v5_proposals p WHERE p.id=%1$I.proposal_id AND p.tenant_id=%1$I.tenant_id AND p.session_id=%1$I.session_id))',t);
  EXECUTE format('CREATE POLICY control_write ON finnor_os.%1$I FOR INSERT WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid AND EXISTS(SELECT 1 FROM finnor_os.v5_proposals p WHERE p.id=%1$I.proposal_id AND p.tenant_id=%1$I.tenant_id AND p.session_id=%1$I.session_id))',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['v5_commands','v5_cursors'] LOOP
  EXECUTE format('CREATE POLICY private_context ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid AND finnor_os.v5_session_visible(session_id)) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid AND finnor_os.v5_session_visible(session_id))',t);
 END LOOP;
END $$;
CREATE POLICY evaluation_update ON finnor_os.v5_evaluations FOR UPDATE
 USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY dispatch_update ON finnor_os.v5_dispatch_refs FOR UPDATE
 USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY history_read ON finnor_os.v5_history FOR SELECT
 USING(tenant_id=finnor_os.request_tenant_id() AND finnor_os.v5_session_visible(session_id)
  AND (principal_id=nullif(current_setting('app.user_id',true),'')::uuid OR branch_id IS NOT NULL AND finnor_os.v5_branch_visible(branch_id))
  AND finnor_os.v5_resources_visible(resources));
CREATE POLICY history_write ON finnor_os.v5_history FOR INSERT
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid
  AND finnor_os.v5_session_visible(session_id) AND finnor_os.v5_resources_visible(resources)
  AND (branch_id IS NULL OR EXISTS(SELECT 1 FROM finnor_os.v5_branches b
    WHERE b.id=v5_history.branch_id AND b.tenant_id=v5_history.tenant_id AND b.session_id=v5_history.session_id
      AND (b.principal_id=v5_history.principal_id OR v5_history.kind='EXACT_APPROVAL_RECORDED'))));
GRANT SELECT,INSERT ON finnor_os.v5_branches,finnor_os.v5_evaluations,finnor_os.v5_proposals,
 finnor_os.v5_approval_refs,finnor_os.v5_dispatch_refs,finnor_os.v5_history,finnor_os.v5_commands,finnor_os.v5_cursors TO finnor_app;
GRANT UPDATE ON finnor_os.v5_evaluations,finnor_os.v5_dispatch_refs TO finnor_app;
-- Historical default privileges otherwise retain UPDATE on new tables.
REVOKE UPDATE ON finnor_os.v5_cursors FROM finnor_app;
GRANT DELETE ON finnor_os.v5_cursors TO finnor_app;
GRANT USAGE ON SEQUENCE finnor_os.v5_history_id_seq TO finnor_app;
-- Ordinary recipient SQL must not expose another author's private proof vector.
-- Only a bounded boolean comparison crosses this boundary. The HTTP service
-- supplies its independently reloaded original/current vector.
REVOKE SELECT ON finnor_os.v5_cursors FROM finnor_app;
GRANT SELECT(id,tenant_id,session_id,principal_id,delivery_session_id,projection_digest,expires_at)
 ON finnor_os.v5_cursors TO finnor_app;
CREATE FUNCTION finnor_os.v5_control_cut_matches(p_cut uuid,p_session uuid,p_delivery uuid,p_basis text,p_vector jsonb,p_base_only boolean DEFAULT false)
 RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT octet_length(p_vector::text)<=2097152 AND length(p_basis)<=256 AND EXISTS(
  SELECT 1 FROM finnor_os.v5_cursors c
   JOIN finnor_os.v5_sessions s ON s.tenant_id=c.tenant_id AND s.id=c.session_id
   JOIN finnor_os.auth_delivery_sessions d ON d.tenant_id=c.tenant_id AND d.session_id=c.delivery_session_id
  WHERE c.id=p_cut AND c.tenant_id=finnor_os.request_tenant_id() AND c.session_id=p_session
    AND c.principal_id=nullif(current_setting('app.user_id',true),'')::uuid
    AND c.delivery_session_id=p_delivery AND c.expires_at>clock_timestamp()
    AND d.principal_id=c.principal_id AND d.revoked_at IS NULL AND d.expires_at>clock_timestamp()
    AND finnor_os.may_query_resource('work',s.work_id::text)
    AND finnor_os.may_query_resource(s.root->>'entityType',s.root->>'entityId')
    AND finnor_os.may_query_resource(s.focus->>'type',s.focus->>'id')
    AND c.owner_vectors ? p_basis
    AND CASE WHEN p_base_only THEN p_basis='session' AND c.owner_vectors->'session'=p_vector
      ELSE c.owner_vectors->p_basis=p_vector END)
 $$;
REVOKE ALL ON FUNCTION finnor_os.v5_control_cut_matches(uuid,uuid,uuid,text,jsonb,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.v5_control_cut_matches(uuid,uuid,uuid,text,jsonb,boolean) TO finnor_app;
CREATE FUNCTION finnor_os.v5_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'V5 original control evidence is immutable'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['v5_sessions','v5_participants','v5_consequence_grants','v5_branch_custody','v5_proposal_custody','v5_proposals','v5_approval_refs','v5_history','v5_commands'] LOOP
  EXECUTE format('CREATE TRIGGER original_control_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.v5_immutable()',t);
 END LOOP;
END $$;
CREATE FUNCTION finnor_os.v5_branch_original_guard() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,finnor_os AS $$
 BEGIN
  IF TG_OP='INSERT' THEN NEW.current_visibility:=NEW.visibility;RETURN NEW;END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'current_visibility')=(to_jsonb(OLD)-'current_visibility')
    AND NEW.current_visibility=(SELECT h.body->>'visibility' FROM finnor_os.v5_history h
      WHERE h.tenant_id=OLD.tenant_id AND h.branch_id=OLD.id AND h.principal_id=OLD.principal_id
        AND h.kind='BRANCH_VISIBILITY' ORDER BY h.id DESC LIMIT 1)
  THEN RETURN NEW;END IF;
  RAISE EXCEPTION 'V5 original branch evidence is immutable';
 END $$;
CREATE TRIGGER original_control_immutable BEFORE INSERT OR UPDATE OR DELETE ON finnor_os.v5_branches
 FOR EACH ROW EXECUTE FUNCTION finnor_os.v5_branch_original_guard();
CREATE FUNCTION finnor_os.v5_project_visibility() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,finnor_os AS $$
 BEGIN
  IF NEW.kind='BRANCH_VISIBILITY' THEN
   IF NEW.body->>'visibility' NOT IN('PRIVATE','SHARED') THEN RAISE EXCEPTION 'Invalid V5 visibility';END IF;
   UPDATE finnor_os.v5_branches SET current_visibility=NEW.body->>'visibility'
    WHERE tenant_id=NEW.tenant_id AND session_id=NEW.session_id AND id=NEW.branch_id AND principal_id=NEW.principal_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'V5 visibility owner mismatch';END IF;
  END IF;
  RETURN NULL;
 END $$;
REVOKE ALL ON FUNCTION finnor_os.v5_project_visibility() FROM PUBLIC;
CREATE TRIGGER visibility_projection AFTER INSERT ON finnor_os.v5_history
 FOR EACH ROW EXECUTE FUNCTION finnor_os.v5_project_visibility();
CREATE INDEX v5_branch_session ON finnor_os.v5_branches(tenant_id,session_id,created_at,id);
CREATE INDEX v5_evaluation_branch ON finnor_os.v5_evaluations(tenant_id,branch_id,created_at,id);
CREATE INDEX v5_proposal_session ON finnor_os.v5_proposals(tenant_id,session_id,created_at,id);
CREATE INDEX v5_history_session ON finnor_os.v5_history(tenant_id,session_id,created_at,id);
CREATE INDEX v5_cursor_delivery ON finnor_os.v5_cursors(tenant_id,principal_id,delivery_session_id,expires_at);
CREATE INDEX v5_visibility_branch ON finnor_os.v5_history(tenant_id,branch_id,id DESC) WHERE kind='BRANCH_VISIBILITY';
ALTER TABLE finnor_os.v5_branches ADD FOREIGN KEY(tenant_id,session_id,parent_id) REFERENCES finnor_os.v5_branches(tenant_id,session_id,id);
ALTER TABLE finnor_os.v5_sessions ADD FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id);
ALTER TABLE finnor_os.v5_sessions ADD FOREIGN KEY(tenant_id,created_by) REFERENCES finnor_os.users(tenant_id,id);
ALTER TABLE finnor_os.auth_delivery_sessions ADD FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id);
ALTER TABLE finnor_os.employee_actor_profiles ADD FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id);
ALTER TABLE finnor_os.employee_actor_profiles ADD FOREIGN KEY(tenant_id,delegated_by) REFERENCES finnor_os.users(tenant_id,id);
-- The original id primary keys imply uniqueness, but PostgreSQL requires the
-- exact composite key for a tenant-preserving reference.
CREATE UNIQUE INDEX v5_assignment_tenant_identity ON finnor_os.employee_role_assignments(tenant_id,id);
CREATE UNIQUE INDEX v5_delegation_tenant_identity ON finnor_os.delegations(tenant_id,id);
ALTER TABLE finnor_os.employee_actor_profiles ADD FOREIGN KEY(tenant_id,authority_assignment_id) REFERENCES finnor_os.employee_role_assignments(tenant_id,id);
ALTER TABLE finnor_os.employee_actor_profiles ADD FOREIGN KEY(tenant_id,delegation_id) REFERENCES finnor_os.delegations(tenant_id,id);
ALTER TABLE finnor_os.v5_participants ADD FOREIGN KEY(tenant_id,delivery_session_id) REFERENCES finnor_os.auth_delivery_sessions(tenant_id,session_id);
ALTER TABLE finnor_os.v5_participants ADD FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id);
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('evaluate_live_control_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
  'Original-grant finite native V5 consequence evaluation; no reservation or execution authority.');
