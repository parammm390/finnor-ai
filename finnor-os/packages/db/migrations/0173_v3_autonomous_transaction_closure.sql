-- V3 owns accepted closing programmes and immutable close certificates, not a
-- second authority, evidence, resource, provider-attempt or accounting ledger.
-- 0172 is an unpublished peer reservation, not a dependency of this migration.
CREATE TABLE finnor_os.pe_closing_profiles (
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  environment text NOT NULL CHECK (environment IN ('DEVELOPMENT','REHEARSAL','LIVE')),
  status text NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  body jsonb NOT NULL CHECK (jsonb_typeof(body)='object'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  valid_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id)
);
CREATE FUNCTION finnor_os.pe_closing_profile_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(OLD)-'status') IS DISTINCT FROM (to_jsonb(NEW)-'status')
    OR OLD.status='REVOKED' AND NEW.status<>'REVOKED' THEN
    RAISE EXCEPTION 'Qualified profile preimages are immutable; use a new profile identity or append revocation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pe_closing_profile_guard BEFORE UPDATE OR DELETE ON finnor_os.pe_closing_profiles
  FOR EACH ROW EXECUTE FUNCTION finnor_os.pe_closing_profile_guard();

CREATE TABLE finnor_os.pe_closing_programmes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  transaction_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  work_id uuid NOT NULL,
  work_input_id uuid NOT NULL,
  work_input_digest text NOT NULL,
  plan_revision_id uuid,
  profile_id text NOT NULL,
  profile_digest text NOT NULL,
  accepted_terms_source_id uuid NOT NULL,
  accepted_terms_version_id uuid NOT NULL,
  approved_terms_revision text NOT NULL,
  spec jsonb NOT NULL CHECK (jsonb_typeof(spec)='object'),
  spec_digest text NOT NULL CHECK (spec_digest ~ '^[a-f0-9]{64}$'),
  graph jsonb NOT NULL CHECK (jsonb_typeof(graph)='object'),
  dependency_pins jsonb NOT NULL CHECK (jsonb_typeof(dependency_pins)='array'),
  authority_revision integer NOT NULL,
  intake_authority_decision_id uuid NOT NULL,
  original_deadline_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PROPOSED' CHECK(status IN
    ('PROPOSED','WAITING','BLOCKED','STOPPED','FAILED','EXECUTING','RECONCILING','READY_FOR_PUBLICATION','CLOSED','REOPENED')),
  generation integer NOT NULL DEFAULT 1,
  stopped_at timestamptz,
  reason text,
  last_check_id uuid,
  publication_action_id uuid,
  controller_lease_token uuid,
  controller_lease_until timestamptz,
  idempotency_key text NOT NULL,
  intake_digest text NOT NULL CHECK(intake_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,principal_id,idempotency_key),
  FOREIGN KEY(tenant_id,transaction_id) REFERENCES finnor_os.pe_deals(tenant_id,id),
  FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
  FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
  FOREIGN KEY(tenant_id,profile_id) REFERENCES finnor_os.pe_closing_profiles(tenant_id,id),
  FOREIGN KEY(accepted_terms_version_id) REFERENCES finnor_os.evidence_source_versions(id),
  FOREIGN KEY(intake_authority_decision_id) REFERENCES finnor_os.authority_decisions(id)
);
CREATE UNIQUE INDEX pe_closing_one_current_transaction ON finnor_os.pe_closing_programmes(tenant_id,transaction_id)
  WHERE status NOT IN('STOPPED','FAILED','REOPENED');

-- Larger finite closing graphs use the existing Objective counters. This is a
-- bounded V3 extension, not fresh per-child grants or a change to ordinary/IC
-- defaults. Existing episode ceilings cannot be increased by a continuation.
ALTER TABLE finnor_os.work_objective_loops DROP CONSTRAINT work_objective_loops_max_steps_check;
ALTER TABLE finnor_os.work_objective_loops ADD CONSTRAINT work_objective_loops_max_steps_check CHECK(max_steps BETWEEN 1 AND 4096);
ALTER TABLE finnor_os.work_objective_loops DROP CONSTRAINT work_objective_loops_max_actions_check;
ALTER TABLE finnor_os.work_objective_loops ADD CONSTRAINT work_objective_loops_max_actions_check CHECK(max_actions BETWEEN 0 AND 4096);
ALTER TABLE finnor_os.work_objective_loops DROP CONSTRAINT work_objective_loops_max_queries_check;
ALTER TABLE finnor_os.work_objective_loops ADD CONSTRAINT work_objective_loops_max_queries_check CHECK(max_queries BETWEEN 1 AND 4096);
CREATE FUNCTION finnor_os.pe_v3_objective_grant_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.max_steps>OLD.max_steps OR NEW.max_actions>OLD.max_actions
    OR NEW.max_queries>OLD.max_queries OR NEW.deadline_at>OLD.deadline_at) AND EXISTS(
      SELECT 1 FROM finnor_os.pe_closing_programmes q WHERE q.tenant_id=NEW.tenant_id AND q.work_id=NEW.work_id) THEN
    RAISE EXCEPTION 'Closing continuation cannot increase the original episode grant';
  END IF;
  IF (NEW.max_steps>96 OR NEW.max_actions>25 OR NEW.max_queries>50) AND NOT EXISTS(
    SELECT 1 FROM finnor_os.pe_closing_programmes q WHERE q.tenant_id=NEW.tenant_id AND q.work_id=NEW.work_id
      AND NEW.max_steps<=(q.spec->'originalGrant'->>'maxSteps')::int AND NEW.max_actions<=NEW.max_steps AND NEW.max_queries<=NEW.max_steps
      AND NEW.deadline_at<=q.original_deadline_at
      AND EXISTS(SELECT 1 FROM finnor_os.pe_closing_evidence_bindings b JOIN finnor_os.evidence_source_versions v
        ON v.tenant_id=b.tenant_id AND v.source_id=b.source_id
        WHERE b.tenant_id=q.tenant_id AND b.programme_id=q.id AND v.snapshot->'closingObservation'->>'kind'='LEGAL_SPEC_ACCEPTANCE')) THEN
    RAISE EXCEPTION 'Larger finite grant requires the original accepted closing Work';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pe_v3_objective_grant_guard BEFORE INSERT OR UPDATE ON finnor_os.work_objective_loops
  FOR EACH ROW EXECUTE FUNCTION finnor_os.pe_v3_objective_grant_guard();

CREATE TABLE finnor_os.pe_closing_evidence_bindings (
  tenant_id uuid NOT NULL,
  programme_id uuid NOT NULL,
  source_id uuid NOT NULL REFERENCES finnor_os.evidence_sources(id),
  requirement_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,programme_id,source_id),
  FOREIGN KEY(tenant_id,programme_id) REFERENCES finnor_os.pe_closing_programmes(tenant_id,id)
);
CREATE TABLE finnor_os.pe_closing_node_links (
  tenant_id uuid NOT NULL,
  programme_id uuid NOT NULL,
  node_key text NOT NULL,
  domain_action_id uuid NOT NULL,
  business_effect_id uuid,
  consumption_ref jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,programme_id,node_key),
  UNIQUE(tenant_id,domain_action_id),
  FOREIGN KEY(tenant_id,programme_id) REFERENCES finnor_os.pe_closing_programmes(tenant_id,id),
  FOREIGN KEY(tenant_id,domain_action_id) REFERENCES finnor_os.domain_actions(tenant_id,id),
  FOREIGN KEY(tenant_id,business_effect_id) REFERENCES finnor_os.business_effects(tenant_id,id)
);
CREATE TABLE finnor_os.s6_closing_duty_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  programme_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  duty_key text NOT NULL,
  task_id uuid NOT NULL,
  authority_decision_id uuid NOT NULL,
  body jsonb NOT NULL,
  digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,transaction_id,duty_key),
  FOREIGN KEY(tenant_id,programme_id) REFERENCES finnor_os.pe_closing_programmes(tenant_id,id),
  FOREIGN KEY(tenant_id,transaction_id) REFERENCES finnor_os.pe_deals(tenant_id,id),
  FOREIGN KEY(tenant_id,task_id) REFERENCES finnor_os.tasks(tenant_id,id),
  FOREIGN KEY(authority_decision_id) REFERENCES finnor_os.authority_decisions(id)
);
-- An effect is compiled before the native executor can dispatch. Bind it in
-- that same commit, including the automatically executable policy path.
CREATE FUNCTION finnor_os.pe_closing_bind_compiled_effect() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM finnor_os.pe_closing_node_links l
    WHERE l.tenant_id=NEW.tenant_id AND l.domain_action_id=NEW.domain_action_id
      AND l.business_effect_id IS NOT NULL AND l.business_effect_id<>NEW.id) THEN
    RAISE EXCEPTION 'Original closing child already owns a different effect';
  END IF;
  UPDATE finnor_os.pe_closing_node_links SET business_effect_id=NEW.id
    WHERE tenant_id=NEW.tenant_id AND domain_action_id=NEW.domain_action_id AND business_effect_id IS NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER pe_closing_bind_compiled_effect AFTER INSERT ON finnor_os.business_effects
  FOR EACH ROW EXECUTE FUNCTION finnor_os.pe_closing_bind_compiled_effect();
CREATE TABLE finnor_os.pe_closing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  programme_id uuid NOT NULL,
  generation integer NOT NULL,
  kind text NOT NULL,
  body jsonb NOT NULL,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,programme_id) REFERENCES finnor_os.pe_closing_programmes(tenant_id,id),
  UNIQUE(tenant_id,programme_id,idempotency_key)
);

-- Only the independently administered checker role may insert a check. Normal
-- API/worker credentials can read receipts but cannot certify their own output.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_closing_checker') THEN
    CREATE ROLE finnor_closing_checker NOLOGIN NOINHERIT;
  END IF;
END $$;
CREATE TABLE finnor_os.pe_closing_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  programme_id uuid NOT NULL,
  spec_digest text NOT NULL,
  observation_cut_digest text NOT NULL,
  observation_basis_digest text NOT NULL,
  checker_digest text NOT NULL,
  body jsonb NOT NULL,
  accepted boolean NOT NULL,
  valid_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,programme_id) REFERENCES finnor_os.pe_closing_programmes(tenant_id,id),
  CHECK(accepted=(body->>'accepted')::boolean),
  CHECK(spec_digest=body->>'specDigest')
);
CREATE TABLE finnor_os.pe_closed_transaction_certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  programme_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  check_id uuid NOT NULL,
  body jsonb NOT NULL,
  post_publication_cut_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,programme_id),
  FOREIGN KEY(tenant_id,programme_id) REFERENCES finnor_os.pe_closing_programmes(tenant_id,id),
  FOREIGN KEY(tenant_id,check_id) REFERENCES finnor_os.pe_closing_checks(tenant_id,id)
);
ALTER TABLE finnor_os.pe_closing_programmes ADD FOREIGN KEY(tenant_id,last_check_id)
  REFERENCES finnor_os.pe_closing_checks(tenant_id,id);

CREATE FUNCTION finnor_os.pe_closing_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN RAISE EXCEPTION 'V3 historical evidence is immutable; append a correction or lifecycle event'; END $$;
CREATE FUNCTION finnor_os.pe_closing_programme_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'PROPOSED' OR NEW.last_check_id IS NOT NULL OR NEW.publication_action_id IS NOT NULL THEN
      RAISE EXCEPTION 'Initial closing programme cannot assert independent check or publication';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.publication_action_id IS NOT NULL AND NEW.publication_action_id IS DISTINCT FROM OLD.publication_action_id THEN
    RAISE EXCEPTION 'Original closing publication action is immutable';
  END IF;
  IF (to_jsonb(OLD)-ARRAY['status','generation','stopped_at','reason','last_check_id','publication_action_id','plan_revision_id','controller_lease_token','controller_lease_until','updated_at'])
    IS DISTINCT FROM
    (to_jsonb(NEW)-ARRAY['status','generation','stopped_at','reason','last_check_id','publication_action_id','plan_revision_id','controller_lease_token','controller_lease_until','updated_at']) THEN
    RAISE EXCEPTION 'Accepted ClosingSpec, Work, terms, grant and authority bindings are immutable';
  END IF;
  IF NEW.status='CLOSED' AND OLD.status<>'CLOSED'
    AND (current_setting('app.v3_publication',true) IS DISTINCT FROM NEW.id::text
      OR NOT EXISTS(SELECT 1 FROM finnor_os.pe_closed_transaction_certificates cert
        JOIN finnor_os.pe_closing_checks c ON c.tenant_id=cert.tenant_id AND c.id=cert.check_id
        JOIN finnor_os.pe_deals d ON d.tenant_id=cert.tenant_id AND d.id=cert.transaction_id
        WHERE cert.tenant_id=NEW.tenant_id AND cert.programme_id=NEW.id AND c.accepted
          AND c.spec_digest=NEW.spec_digest AND c.valid_until>clock_timestamp() AND d.status='closed')) THEN
    RAISE EXCEPTION 'CLOSED is owned by canonical independently checked publication';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pe_closing_programme_guard BEFORE INSERT OR UPDATE ON finnor_os.pe_closing_programmes
  FOR EACH ROW EXECUTE FUNCTION finnor_os.pe_closing_programme_guard();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pe_closing_checks','pe_closed_transaction_certificates','pe_closing_events','s6_closing_duty_handoffs'] LOOP
    EXECUTE format('CREATE TRIGGER v3_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.pe_closing_immutable()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['pe_closing_profiles','pe_closing_programmes','pe_closing_evidence_bindings','pe_closing_node_links','s6_closing_duty_handoffs','pe_closing_events','pe_closing_checks','pe_closed_transaction_certificates'] LOOP
    EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY v3_tenant ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id()) WITH CHECK(tenant_id=finnor_os.request_tenant_id())',t);
    -- 0032's DEFAULT PRIVILEGES grant app DML on newly created tables.
    -- Additive grants alone do not create an independent checker boundary.
    EXECUTE format('REVOKE ALL ON finnor_os.%I FROM finnor_app,PUBLIC',t);
    EXECUTE format('GRANT SELECT ON finnor_os.%I TO finnor_app,finnor_closing_checker',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['pe_closing_programmes','pe_closing_evidence_bindings','pe_closing_node_links','s6_closing_duty_handoffs','pe_closing_events'] LOOP
    EXECUTE format('GRANT INSERT ON finnor_os.%I TO finnor_app',t);
  END LOOP;
END $$;
GRANT UPDATE(status,generation,stopped_at,reason,last_check_id,publication_action_id,plan_revision_id,controller_lease_token,controller_lease_until,updated_at)
  ON finnor_os.pe_closing_programmes TO finnor_app;
GRANT UPDATE(business_effect_id,consumption_ref) ON finnor_os.pe_closing_node_links TO finnor_app;
GRANT USAGE ON SCHEMA finnor_os TO finnor_closing_checker;
GRANT INSERT ON finnor_os.pe_closing_checks TO finnor_closing_checker;
GRANT SELECT ON finnor_os.evidence_sources,finnor_os.evidence_source_versions,
  finnor_os.users,finnor_os.authority_states,finnor_os.authority_decisions,
  finnor_os.employee_role_assignments,finnor_os.employee_roles,finnor_os.role_authority_grants,
  finnor_os.works,finnor_os.work_inputs,finnor_os.work_plan_revisions,
  finnor_os.business_effects,finnor_os.domain_actions,finnor_os.external_operations,
  finnor_os.provider_operation_attempts,finnor_os.provider_invocations,
  finnor_os.pe_closing_conditions,finnor_os.pe_closing_items,finnor_os.pe_deals,
  finnor_os.p4_source_revisions,finnor_os.tasks
  TO finnor_closing_checker;
GRANT SELECT ON finnor_os.tenant_integrations TO finnor_closing_checker;
GRANT SELECT ON finnor_os.documents,finnor_os.document_versions,finnor_os.document_version_contents,
  finnor_os.document_version_heads TO finnor_closing_checker;
GRANT SELECT ON finnor_os.work_objective_loops TO finnor_closing_checker;
GRANT SELECT ON finnor_os.decision_receipts,finnor_os.authority_approval_requests,
  finnor_os.s5_proposals,finnor_os.s5_resources,finnor_os.s5_resource_heads,
  finnor_os.s5_reservations,finnor_os.s5_reservation_origins,
  finnor_os.s5_consumptions,finnor_os.s5_consumption_states TO finnor_closing_checker;
GRANT EXECUTE ON FUNCTION finnor_os.pe_governance_proof_valid(uuid,text,uuid,text,uuid,uuid,boolean,boolean)
  TO finnor_closing_checker;

-- One exact material cut, resolved by the checker from its own DB session. The
-- producer cannot supply selected observations or suppress attempts/role changes.
CREATE FUNCTION finnor_os.pe_closing_cut(t uuid,p uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,finnor_os AS $$
SELECT jsonb_build_object(
  'programme',to_jsonb(q)-ARRAY['status','reason','last_check_id','publication_action_id','controller_lease_token','controller_lease_until','updated_at'],
  'profile',(SELECT to_jsonb(pr) FROM finnor_os.pe_closing_profiles pr WHERE pr.tenant_id=t AND pr.id=q.profile_id),
  'latestWorkInput',(SELECT to_jsonb(w) FROM finnor_os.work_inputs w WHERE w.tenant_id=t AND w.work_id=q.work_id ORDER BY w.created_at DESC,w.id DESC LIMIT 1),
  'work',(SELECT jsonb_build_object('id',w.id,'cancelled',w.status='cancelled','currentOwnerId',w.current_owner_id) FROM finnor_os.works w WHERE w.tenant_id=t AND w.id=q.work_id),
  'objective',(SELECT jsonb_build_object('id',o.id,'deadlineAt',o.deadline_at,
    'maxSteps',o.max_steps,'maxActions',o.max_actions,'maxQueries',o.max_queries,
    'fenced',o.state IN('blocked','failed','cancelled')) FROM finnor_os.work_objective_loops o WHERE o.tenant_id=t AND o.work_id=q.work_id),
  'deal',(SELECT to_jsonb(d)-ARRAY['status','version','graph_version','actual_close_at','close_authority_decision_id',
    'close_decision_receipt_id','updated_at'] FROM finnor_os.pe_deals d WHERE d.tenant_id=t AND d.id=q.transaction_id),
  'authority',(SELECT to_jsonb(a) FROM finnor_os.authority_states a WHERE a.tenant_id=t),
  'plan',(SELECT jsonb_build_object('id',r.id,'work_input_id',r.work_input_id,'semantic_hash',r.semantic_hash,
    'current',r.status IN('active','completed')) FROM finnor_os.work_plan_revisions r WHERE r.tenant_id=t AND r.id=q.plan_revision_id),
  'actors',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',u.id,'status',u.status,'role',u.role) ORDER BY u.id),'[]') FROM finnor_os.users u WHERE u.tenant_id=t),
  'roles',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') FROM finnor_os.employee_role_assignments a WHERE a.tenant_id=t),
  'roleDefinitions',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') FROM finnor_os.employee_roles a WHERE a.tenant_id=t),
  'grants',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') FROM finnor_os.role_authority_grants a WHERE a.tenant_id=t),
  'latestTerms',(SELECT to_jsonb(v) FROM finnor_os.evidence_source_versions v WHERE v.tenant_id=t AND v.source_id=q.accepted_terms_source_id ORDER BY v.version_number DESC LIMIT 1),
  'documents',(SELECT coalesce(jsonb_agg(jsonb_build_object('document',to_jsonb(d),'version',to_jsonb(v),
    'head',to_jsonb(h),'content',jsonb_build_object('sha256',content.sha256,'storage_backend',content.storage_backend,
      'storage_ref',content.storage_ref,'actual_sha256',CASE WHEN content.bytes IS NOT NULL THEN encode(sha256(content.bytes),'hex') END))
    ORDER BY d.id),'[]')
    FROM jsonb_array_elements(q.spec->'documents') spec_document
    JOIN finnor_os.documents d ON d.tenant_id=t
      AND d.id=CASE WHEN spec_document->>'documentId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (spec_document->>'documentId')::uuid END
    LEFT JOIN finnor_os.document_versions v ON v.tenant_id=t AND v.document_id=d.id
      AND v.id=CASE WHEN spec_document->>'documentVersionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (spec_document->>'documentVersionId')::uuid END
    LEFT JOIN finnor_os.document_version_heads h ON h.tenant_id=t AND h.document_id=d.id AND h.kind='current' AND h.head_key='default'
    LEFT JOIN finnor_os.document_version_contents content ON content.tenant_id=t AND content.version_id=v.id),
  'evidence',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.source_id,v.version_number),'[]')
    FROM finnor_os.evidence_source_versions v JOIN finnor_os.pe_closing_evidence_bindings b ON b.tenant_id=v.tenant_id AND b.source_id=v.source_id
    WHERE b.tenant_id=t AND b.programme_id=p),
  'dependencies',(SELECT coalesce(jsonb_agg(jsonb_build_object('key',r.key,'revision',r.revision) ORDER BY r.key),'[]')
    FROM finnor_os.p4_source_revisions r WHERE r.tenant_id=t AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.dependency_pins) d WHERE d->>'key'=r.key)),
  'children',(SELECT coalesce(jsonb_agg(jsonb_build_object('link',to_jsonb(l),
    'action',CASE WHEN l.node_key='publish-close' AND a.action_type='declare_deal_closed' THEN
      jsonb_build_object('id',a.id,'action_type',a.action_type,'initiated_by',a.initiated_by,'work_id',a.work_id,
        'plan_revision_id',a.plan_revision_id,'plan_node_id',a.plan_node_id,'payload',a.payload,
        'grounded_payload',a.grounded_payload,'authority_revision',a.authority_revision)
      ELSE to_jsonb(a) END,
    'effect',CASE WHEN l.node_key='publish-close' AND a.action_type='declare_deal_closed' THEN
      jsonb_build_object('id',e.id,'semantic_hash',e.semantic_hash,'effect',e.effect)
      ELSE to_jsonb(e) END) ORDER BY l.node_key),'[]')
    FROM finnor_os.pe_closing_node_links l JOIN finnor_os.domain_actions a ON a.tenant_id=t AND a.id=l.domain_action_id
    LEFT JOIN finnor_os.business_effects e ON e.tenant_id=t AND e.id=l.business_effect_id WHERE l.tenant_id=t AND l.programme_id=p),
  'operations',(SELECT coalesce(jsonb_agg(jsonb_build_object('operation',to_jsonb(o),
    'link',to_jsonb(l),'originalSpec',prior.spec,'originalProfile',(SELECT to_jsonb(pr) FROM finnor_os.pe_closing_profiles pr WHERE pr.tenant_id=t AND pr.id=prior.profile_id),
    'originalProfileDigest',prior.profile_digest,
    'settlementEvidence',(SELECT to_jsonb(v) FROM finnor_os.evidence_source_versions v WHERE v.tenant_id=t
      AND v.id=CASE WHEN o.observation->'closingEvidenceRef'->>'versionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (o.observation->'closingEvidenceRef'->>'versionId')::uuid END
      AND EXISTS(SELECT 1 FROM finnor_os.pe_closing_evidence_bindings b WHERE b.tenant_id=t AND b.programme_id=prior.id AND b.source_id=v.source_id)),
    'settlementCandidates',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.version_number,v.id),'[]')
      FROM finnor_os.evidence_source_versions v JOIN finnor_os.pe_closing_evidence_bindings b ON b.tenant_id=v.tenant_id AND b.source_id=v.source_id
      WHERE b.tenant_id=t AND b.programme_id=prior.id
        AND v.snapshot->'closingObservation'->>'requirementKey'=(SELECT st->>'requirementKey'
          FROM jsonb_array_elements(prior.spec->'steps') st WHERE st->>'key'=l.node_key)),
    'attempts',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.ordinal),'[]') FROM finnor_os.provider_operation_attempts a WHERE a.tenant_id=t AND a.external_operation_id=o.id),
    'invocations',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.started_at,i.id),'[]') FROM finnor_os.provider_invocations i
      JOIN finnor_os.provider_operation_attempts a ON a.tenant_id=i.tenant_id AND a.id=i.provider_operation_attempt_id WHERE a.tenant_id=t AND a.external_operation_id=o.id)) ORDER BY o.id),'[]')
    FROM finnor_os.external_operations o JOIN finnor_os.pe_closing_node_links l ON l.tenant_id=t AND l.business_effect_id=o.business_effect_id
      JOIN finnor_os.pe_closing_programmes prior ON prior.tenant_id=t AND prior.id=l.programme_id
      WHERE o.tenant_id=t AND prior.transaction_id=q.transaction_id),
  'duties',(SELECT coalesce(jsonb_agg(jsonb_build_object('handoff',to_jsonb(h),'task',to_jsonb(task),'authority',to_jsonb(a),
    'action',to_jsonb(da)) ORDER BY h.duty_key),'[]')
    FROM finnor_os.s6_closing_duty_handoffs h JOIN finnor_os.tasks task ON task.tenant_id=t AND task.id=h.task_id
      JOIN finnor_os.authority_decisions a ON a.tenant_id=t AND a.id=h.authority_decision_id
      JOIN finnor_os.domain_actions da ON da.tenant_id=t AND da.id=task.source_domain_action_id
      WHERE h.tenant_id=t AND h.transaction_id=q.transaction_id),
  'conditions',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]') FROM finnor_os.pe_closing_conditions c WHERE c.tenant_id=t AND c.deal_id=q.transaction_id),
  'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]') FROM finnor_os.pe_closing_items i WHERE i.tenant_id=t AND i.deal_id=q.transaction_id),
  'waivers',(SELECT coalesce(jsonb_agg(jsonb_build_object('condition',to_jsonb(c),'authority',to_jsonb(a),
    'current',finnor_os.pe_governance_proof_valid(t,'pe_closing_condition',c.id,'private_equity:waive_closing_condition',
      c.waiver_authority_decision_id,c.waiver_decision_receipt_id,true,c.waiver_requires_approval)) ORDER BY c.id),'[]')
    FROM finnor_os.pe_closing_conditions c JOIN finnor_os.authority_decisions a ON a.tenant_id=t AND a.id=c.waiver_authority_decision_id
    WHERE c.tenant_id=t AND c.deal_id=q.transaction_id AND c.state='waived'),
  'allocations',(SELECT coalesce(jsonb_agg(jsonb_build_object('certificate',pr.certificate,'problem',pr.problem,
    'reservation',jsonb_build_object('id',s.reservation_id,'revocationReason',s.revocation_reason),
    'currentResources',(SELECT coalesce(jsonb_agg(r.body ORDER BY r.resource_id),'[]') FROM finnor_os.s5_resource_heads h
      JOIN finnor_os.s5_resources r USING(tenant_id,resource_id,revision) WHERE r.tenant_id=t)) ORDER BY pr.content_digest),'[]')
    FROM finnor_os.s5_proposals pr JOIN finnor_os.s5_reservations s ON s.tenant_id=t AND s.allocation_digest=pr.content_digest
    WHERE pr.tenant_id=t AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.spec->'steps') st WHERE st->'allocationRef'->>'contentDigest'=pr.content_digest)),
  'integrations',(SELECT coalesce(jsonb_agg(to_jsonb(i)-ARRAY['config','credential_ref','credential_metadata'] ORDER BY i.id),'[]') FROM finnor_os.tenant_integrations i
    WHERE i.tenant_id=t AND i.id IN(SELECT CASE WHEN pr->>'integrationId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (pr->>'integrationId')::uuid END
      FROM finnor_os.pe_closing_profiles profile,jsonb_array_elements(profile.body->'providers') pr WHERE profile.tenant_id=t AND profile.id=q.profile_id)),
  'terminated',EXISTS(SELECT 1 FROM finnor_os.pe_deals d WHERE d.tenant_id=t AND d.id=q.transaction_id AND d.status='terminated')
) FROM finnor_os.pe_closing_programmes q WHERE q.tenant_id=t AND q.id=p AND finnor_os.request_tenant_id()=t
$$;
CREATE FUNCTION finnor_os.pe_closing_cut_digest(t uuid,p uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,finnor_os AS $$
SELECT encode(sha256(convert_to(finnor_os.pe_closing_cut(t,p)::text,'UTF8')),'hex')
$$;
CREATE FUNCTION finnor_os.pe_closing_execution_basis_from_cut(body jsonb,own_effect uuid) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,finnor_os AS $$
SELECT encode(sha256(convert_to(((body-ARRAY['children','operations','duties'])||
  jsonb_build_object('materialExposures',coalesce((SELECT jsonb_agg(jsonb_build_object(
    'effectId',o->'operation'->>'business_effect_id','verification',o->'operation'->>'verification_status',
    'observation',o->'operation'->'observation') ORDER BY o->'operation'->>'id')
    FROM jsonb_array_elements(body->'operations') o
    WHERE (own_effect IS NULL OR o->'operation'->>'business_effect_id'<>own_effect::text)
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(o->'invocations') i WHERE
        CASE WHEN o->'operation'->>'provider'='finnor_closing_provider'
          THEN i->>'closing_provider_egress_at' IS NOT NULL ELSE i->>'request_may_have_left_at' IS NOT NULL END)),'[]'::jsonb)))::text,'UTF8')),'hex')
$$;
CREATE FUNCTION finnor_os.pe_closing_execution_basis_digest(t uuid,p uuid,own_effect uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,finnor_os AS $$
SELECT finnor_os.pe_closing_execution_basis_from_cut(finnor_os.pe_closing_cut(t,p),own_effect)
$$;
CREATE FUNCTION finnor_os.pe_closing_basis_digest(t uuid,p uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,finnor_os AS $$
SELECT finnor_os.pe_closing_execution_basis_digest(t,p,NULL)
$$;
REVOKE ALL ON FUNCTION finnor_os.pe_closing_cut(uuid,uuid),finnor_os.pe_closing_cut_digest(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.pe_closing_basis_digest(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.pe_closing_execution_basis_digest(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.pe_closing_execution_basis_from_cut(jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.pe_closing_cut(uuid,uuid),finnor_os.pe_closing_cut_digest(uuid,uuid),finnor_os.pe_closing_basis_digest(uuid,uuid),finnor_os.request_tenant_id()
  TO finnor_app,finnor_closing_checker;
GRANT EXECUTE ON FUNCTION finnor_os.pe_closing_execution_basis_digest(uuid,uuid,uuid),finnor_os.pe_closing_execution_basis_from_cut(jsonb,uuid)
  TO finnor_app,finnor_closing_checker;

CREATE FUNCTION finnor_os.pe_v3_fence_publication() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE q record;
BEGIN
  IF NEW.status<>'closed' OR OLD.status=NEW.status THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('v3-material-cut:'||NEW.tenant_id::text,0));
  SELECT * INTO q FROM finnor_os.pe_closing_programmes WHERE tenant_id=NEW.tenant_id AND transaction_id=NEW.id
    AND status NOT IN('STOPPED','FAILED','REOPENED') ORDER BY created_at DESC LIMIT 1;
  IF q.id IS NULL THEN RAISE EXCEPTION 'Accepted ClosingSpec required at canonical publication'; END IF;
  IF q.publication_action_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM finnor_os.pe_closing_node_links l
      JOIN finnor_os.domain_actions a ON a.tenant_id=l.tenant_id AND a.id=l.domain_action_id
      JOIN finnor_os.business_effects e ON e.tenant_id=l.tenant_id AND e.id=l.business_effect_id
      JOIN finnor_os.authority_decisions auth ON auth.tenant_id=a.tenant_id AND auth.domain_action_id=a.id
      JOIN finnor_os.decision_receipts receipt ON receipt.tenant_id=a.tenant_id AND receipt.domain_action_id=a.id
    WHERE l.tenant_id=NEW.tenant_id AND l.programme_id=q.id AND l.node_key='publish-close'
      AND a.id=q.publication_action_id AND a.action_type='declare_deal_closed'
      AND a.initiated_by=q.principal_id AND a.work_id=q.work_id AND auth.id=NEW.close_authority_decision_id
      AND auth.business_effect_id=e.id AND auth.business_effect_hash=e.semantic_hash
      AND receipt.id=NEW.close_decision_receipt_id AND receipt.business_effect_id=e.id
      AND receipt.authorized_effect_hash=e.semantic_hash) THEN
    RAISE EXCEPTION 'Exact original Work publication action, effect, authority and receipt are required';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER aa_v3_fence_publication BEFORE UPDATE ON finnor_os.pe_deals
  FOR EACH ROW EXECUTE FUNCTION finnor_os.pe_v3_fence_publication();

ALTER TABLE finnor_os.provider_invocations ADD COLUMN closing_provider_egress_at timestamptz;
ALTER TABLE finnor_os.provider_invocations ADD COLUMN closing_provider_response_digest text;
CREATE FUNCTION finnor_os.s6_closing_egress_marker_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF TG_OP='DELETE' AND OLD.closing_provider_egress_at IS NOT NULL THEN
    RAISE EXCEPTION 'Possible closing egress responsibility cannot be deleted';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF TG_OP='UPDATE' AND OLD.closing_provider_egress_at IS NOT NULL AND NEW.closing_provider_egress_at IS DISTINCT FROM OLD.closing_provider_egress_at THEN
    RAISE EXCEPTION 'Possible closing egress marker is immutable';
  END IF;
  IF (TG_OP='INSERT' AND NEW.closing_provider_egress_at IS NOT NULL OR TG_OP='UPDATE' AND
    (NEW.closing_provider_egress_at IS DISTINCT FROM OLD.closing_provider_egress_at OR NEW.closing_provider_response_digest IS DISTINCT FROM OLD.closing_provider_response_digest))
    AND current_user<>'finnor_closing_broker' THEN RAISE EXCEPTION 'Closing provider markers require independently owned broker identity'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER s6_closing_egress_marker_guard BEFORE INSERT OR UPDATE OR DELETE ON finnor_os.provider_invocations
  FOR EACH ROW EXECUTE FUNCTION finnor_os.s6_closing_egress_marker_guard();
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_closing_broker') THEN
    CREATE ROLE finnor_closing_broker NOLOGIN NOINHERIT;
  END IF;
END $$;
GRANT USAGE ON SCHEMA finnor_os TO finnor_closing_broker;
GRANT SELECT ON finnor_os.pe_closing_profiles,finnor_os.pe_closing_programmes,
  finnor_os.pe_closing_checks,finnor_os.pe_closing_node_links,finnor_os.pe_closing_evidence_bindings,
  finnor_os.s6_closing_duty_handoffs,finnor_os.tenant_integrations,
  finnor_os.evidence_sources,finnor_os.evidence_source_versions,finnor_os.users,
  finnor_os.authority_states,finnor_os.authority_decisions,finnor_os.authority_approval_requests,finnor_os.decision_receipts,
  finnor_os.employee_roles,finnor_os.employee_role_assignments,finnor_os.role_authority_grants,
  finnor_os.works,finnor_os.work_inputs,finnor_os.work_plan_revisions,finnor_os.tasks,
  finnor_os.domain_actions,finnor_os.business_effects,finnor_os.external_operations,
  finnor_os.provider_operation_attempts,finnor_os.provider_invocations,
  finnor_os.workflow_runs,finnor_os.workflow_steps,finnor_os.workflow_step_claims,finnor_os.commands,
  finnor_os.pe_deals,finnor_os.pe_closing_conditions,finnor_os.pe_closing_items,finnor_os.p4_source_revisions,
  finnor_os.s5_proposals,finnor_os.s5_resources,finnor_os.s5_resource_heads,
  finnor_os.s5_reservations,finnor_os.s5_reservation_origins,finnor_os.s5_consumptions,finnor_os.s5_consumption_states
  TO finnor_closing_broker;
GRANT SELECT ON finnor_os.documents,finnor_os.document_versions,finnor_os.document_version_contents,
  finnor_os.document_version_heads TO finnor_closing_broker;
GRANT SELECT ON finnor_os.work_objective_loops TO finnor_closing_broker;
GRANT UPDATE(closing_provider_egress_at,closing_provider_response_digest) ON finnor_os.provider_invocations TO finnor_closing_broker;
GRANT EXECUTE ON FUNCTION finnor_os.pe_closing_cut(uuid,uuid),finnor_os.pe_closing_cut_digest(uuid,uuid),finnor_os.pe_closing_basis_digest(uuid,uuid),finnor_os.request_tenant_id()
  TO finnor_closing_broker;
GRANT EXECUTE ON FUNCTION finnor_os.pe_closing_execution_basis_digest(uuid,uuid,uuid),
  finnor_os.pe_closing_execution_basis_from_cut(jsonb,uuid),
  finnor_os.pe_governance_proof_valid(uuid,text,uuid,text,uuid,uuid,boolean,boolean) TO finnor_closing_broker;

ALTER FUNCTION finnor_os.pe_evaluate_deal_close_eligibility(uuid,uuid)
  RENAME TO pe_evaluate_deal_close_eligibility_pre_v3;
CREATE FUNCTION finnor_os.pe_evaluate_deal_close_eligibility(t uuid,d uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,finnor_os AS $$
DECLARE legacy jsonb;q record;check_row record;v3 jsonb;ok boolean:=false;legacy_ok boolean;
BEGIN
  legacy:=finnor_os.pe_evaluate_deal_close_eligibility_pre_v3(t,d);
  legacy_ok:=(legacy->>'eligible')::boolean OR (
    legacy->>'dealState'='closed' AND (legacy->>'signedLoiPresent')::boolean
    AND jsonb_array_length(legacy->'blockingConditions')=0 AND jsonb_array_length(legacy->'failedConditions')=0
    AND jsonb_array_length(legacy->'unverifiedClosingItems')=0 AND jsonb_array_length(legacy->'blockingDependencies')=0
    AND jsonb_array_length(legacy->'invalidWaivers')=0 AND jsonb_array_length(legacy->'integrityErrors')=0);
  SELECT * INTO q FROM finnor_os.pe_closing_programmes WHERE tenant_id=t AND transaction_id=d AND status NOT IN('STOPPED','FAILED','REOPENED') ORDER BY created_at DESC LIMIT 1;
  IF FOUND THEN
    SELECT c.* INTO check_row FROM finnor_os.pe_closing_checks c WHERE c.tenant_id=t AND c.id=q.last_check_id AND c.programme_id=q.id;
    ok:=check_row.id IS NOT NULL AND check_row.accepted AND check_row.spec_digest=q.spec_digest
      AND check_row.valid_until>statement_timestamp() AND q.stopped_at IS NULL
      AND q.original_deadline_at>statement_timestamp()
      AND check_row.observation_cut_digest=finnor_os.pe_closing_cut_digest(t,q.id)
      AND check_row.checker_digest=(SELECT p.body->>'checkerDigest' FROM finnor_os.pe_closing_profiles p WHERE p.tenant_id=t AND p.id=q.profile_id AND p.status='ACTIVE' AND p.valid_until>statement_timestamp());
    v3:=jsonb_build_object('programmeId',q.id,'checkId',check_row.id,'independentlyAccepted',coalesce(ok,false),
      'conjunction',check_row.body->'closeConjunction','reasons',coalesce(check_row.body->'reasons','["INDEPENDENT_CURRENT_CLOSE_CHECK_REQUIRED"]'::jsonb));
  ELSE v3:=jsonb_build_object('independentlyAccepted',false,'reasons',jsonb_build_array('ACCEPTED_CLOSING_SPEC_REQUIRED')); END IF;
  RETURN legacy||jsonb_build_object('eligible',coalesce(legacy_ok,false) AND coalesce(ok,false),'v3',v3);
END $$;

-- The existing canonical declaration function and its state-transition trigger
-- call the replacement above, including the human and direct-SQL routes.
CREATE FUNCTION finnor_os.pe_v3_issue_closed_certificate(t uuid,deal uuid,authority uuid,receipt uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE q record;c record;cut text;cut_body jsonb;body jsonb;d finnor_os.pe_deals%ROWTYPE;certificate_id uuid;
BEGIN
  IF finnor_os.request_tenant_id() IS DISTINCT FROM t THEN RAISE EXCEPTION 'Certificate crosses authenticated tenant'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('v3-material-cut:'||t::text,0));
  SELECT * INTO d FROM finnor_os.pe_deals WHERE tenant_id=t AND id=deal FOR UPDATE;
  IF d.id IS NULL OR d.status<>'closed' THEN RAISE EXCEPTION 'Physical canonical close required'; END IF;
  SELECT * INTO q FROM finnor_os.pe_closing_programmes WHERE tenant_id=t AND transaction_id=deal AND status NOT IN('STOPPED','FAILED','REOPENED') ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE;
  SELECT * INTO c FROM finnor_os.pe_closing_checks WHERE tenant_id=t AND id=q.last_check_id AND programme_id=q.id;
  cut_body:=finnor_os.pe_closing_cut(t,q.id);
  cut:=encode(sha256(convert_to(cut_body::text,'UTF8')),'hex');
  IF q.id IS NULL OR c.id IS NULL OR NOT c.accepted OR c.spec_digest<>q.spec_digest
    OR c.valid_until<=clock_timestamp() OR c.observation_cut_digest<>cut OR q.stopped_at IS NOT NULL
    OR q.original_deadline_at<=clock_timestamp()
    OR c.checker_digest IS DISTINCT FROM (SELECT p.body->>'checkerDigest' FROM finnor_os.pe_closing_profiles p WHERE p.tenant_id=t AND p.id=q.profile_id AND p.status='ACTIVE' AND p.valid_until>clock_timestamp())
    OR NOT finnor_os.pe_governance_proof_valid(t,'pe_deal',deal,'private_equity:close_deal',authority,receipt,true,false)
    OR NOT EXISTS(SELECT 1 FROM finnor_os.pe_closing_node_links l
      JOIN finnor_os.domain_actions a ON a.tenant_id=l.tenant_id AND a.id=l.domain_action_id
      JOIN finnor_os.business_effects e ON e.tenant_id=l.tenant_id AND e.id=l.business_effect_id
      JOIN finnor_os.authority_decisions auth ON auth.tenant_id=a.tenant_id AND auth.domain_action_id=a.id
      JOIN finnor_os.decision_receipts proof ON proof.tenant_id=a.tenant_id AND proof.domain_action_id=a.id
      WHERE l.tenant_id=t AND l.programme_id=q.id AND l.node_key='publish-close' AND a.id=q.publication_action_id
        AND a.action_type='declare_deal_closed' AND a.work_id=q.work_id AND a.initiated_by=q.principal_id
        AND a.created_at>=q.created_at AND auth.id=authority AND auth.business_effect_id=e.id
        AND auth.business_effect_hash=e.semantic_hash AND proof.id=receipt AND proof.business_effect_id=e.id
        AND proof.authorized_effect_hash=e.semantic_hash) THEN
    RAISE EXCEPTION 'Exact current independent check and canonical publication proof required';
  END IF;
  SELECT id INTO certificate_id FROM finnor_os.pe_closed_transaction_certificates WHERE tenant_id=t AND programme_id=q.id;
  IF certificate_id IS NOT NULL THEN RETURN certificate_id; END IF;
  body:=jsonb_build_object(
    'schema','finnor.verified-closed-transaction.v1','artifactType','VerifiedClosedTransaction',
    'transactionIdentity',jsonb_build_object('tenantId',t,'transactionId',deal,'workId',q.work_id),
    'approvedTermsRevision',q.approved_terms_revision,
    'programmeRef',jsonb_build_object('owner','@finnor/private-equity','kind','closing-programme','id',q.id,'version','1','contentDigest',q.spec_digest),
    'closingSpecRef',jsonb_build_object('owner','@finnor/private-equity','kind','closing-spec','id',q.id,'version','1','contentDigest',q.spec_digest),
    'typedPayload',c.body,
    'evidenceAndDerivationRefs',coalesce((SELECT jsonb_agg(e->'ref') FROM jsonb_array_elements(c.body->'acceptedEvidence') e),'[]'),
    'professionalAttestationRefs',coalesce((SELECT jsonb_agg(e->'ref') FROM jsonb_array_elements(c.body->'acceptedEvidence') e WHERE e->>'kind' IN('PROFESSIONAL_CONDITION','LEGAL_EFFECTIVENESS')),'[]'),
    'counterfactualConstraintsAndAssumptions',q.spec->'assumptions',
    'validityAndSupersession',jsonb_build_object('acceptedAt',clock_timestamp(),'validUntil',c.valid_until,'dependencyDigest',cut,'immutableHistoricalCertificate',true,'presentValidityOwner','@finnor/private-equity',
      'supersedes',coalesce((SELECT jsonb_agg(id ORDER BY created_at,id) FROM finnor_os.pe_closed_transaction_certificates WHERE tenant_id=t AND transaction_id=deal),'[]')),
    'authorityReferences',jsonb_build_array(authority,receipt,q.intake_authority_decision_id),
    'fundingAndReservationReferences',coalesce((SELECT jsonb_agg(s->'allocationRef') FROM jsonb_array_elements(q.spec->'steps') s WHERE s->'allocationRef'<>'null'::jsonb),'[]'),
    'dependencyPins',coalesce(cut_body->'dependencies','[]'),
    'continuationAndInvalidationReferences',jsonb_build_array('P7:p4_source_revisions','S6:s6_closing_duty_handoffs'),
    'receiptAndCurrentness',jsonb_build_object('checkId',c.id,'checkerDigest',c.checker_digest,'observationCutDigest',c.observation_cut_digest),
    'evidenceEnvironmentAndCurrentStatus',jsonb_build_object('environment',q.spec->>'environment','label',
      CASE q.spec->>'environment' WHEN 'LIVE' THEN 'LIVE_VERIFIED' WHEN 'REHEARSAL' THEN 'REHEARSAL_ACCEPTED' ELSE 'DEVELOPMENT_VERIFIED' END,
      'statusAtIssuance','CLOSED','excludedFromLiveCounts',q.spec->>'environment'<>'LIVE'),
    'continuingObligations',q.spec->'continuingDuties'
  );
  INSERT INTO finnor_os.pe_closed_transaction_certificates(tenant_id,programme_id,transaction_id,check_id,body,post_publication_cut_digest)
    VALUES(t,q.id,deal,c.id,body,cut) RETURNING id INTO certificate_id;
  PERFORM set_config('app.v3_publication',q.id::text,true);
  UPDATE finnor_os.pe_closing_programmes SET status='CLOSED',updated_at=clock_timestamp() WHERE tenant_id=t AND id=q.id;
  INSERT INTO finnor_os.pe_closing_events(tenant_id,programme_id,generation,kind,body)
    VALUES(t,q.id,q.generation,'INDEPENDENT_CLOSE_PUBLISHED',jsonb_build_object('checkId',c.id,'postPublicationCutDigest',cut,'ownCanonicalCloseDeltaExplicitlyConsumed',true,'physicalCloseRetained',true));
  RETURN certificate_id;
END $$;
REVOKE ALL ON FUNCTION finnor_os.pe_v3_issue_closed_certificate(uuid,uuid,uuid,uuid) FROM PUBLIC,finnor_app;
CREATE FUNCTION finnor_os.pe_v3_record_closed_certificate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status='closed' THEN
    PERFORM finnor_os.pe_v3_issue_closed_certificate(NEW.tenant_id,NEW.id,NEW.close_authority_decision_id,NEW.close_decision_receipt_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER zz_v3_record_closed_certificate AFTER UPDATE ON finnor_os.pe_deals
  FOR EACH ROW EXECUTE FUNCTION finnor_os.pe_v3_record_closed_certificate();

-- Requalification uses the same canonical owner, not a second physical close.
-- Historical Deal status/time/authority and old certificates remain unchanged.
ALTER FUNCTION finnor_os.pe_declare_deal_closed(uuid,uuid,integer,integer,uuid,uuid,text,text) RENAME TO pe_declare_deal_closed_pre_v3;
REVOKE ALL ON FUNCTION finnor_os.pe_declare_deal_closed_pre_v3(uuid,uuid,integer,integer,uuid,uuid,text,text) FROM PUBLIC,finnor_app;
CREATE FUNCTION finnor_os.pe_declare_deal_closed(
  p_tenant uuid,p_deal uuid,p_expected_version integer,p_expected_graph_version integer,
  p_authority_decision uuid,p_decision_receipt uuid,p_source text,p_actor text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE d finnor_os.pe_deals%ROWTYPE;eligibility jsonb;q record;
BEGIN
  IF finnor_os.request_tenant_id() IS DISTINCT FROM p_tenant THEN RAISE EXCEPTION 'PE close crosses authenticated tenant boundary'; END IF;
  IF coalesce(btrim(p_source),'')='' OR coalesce(btrim(p_actor),'')='' THEN RAISE EXCEPTION 'PE close provenance is required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('v3-material-cut:'||p_tenant::text,0));
  SELECT * INTO d FROM finnor_os.pe_deals WHERE tenant_id=p_tenant AND id=p_deal FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PE Deal not found in authenticated tenant'; END IF;
  IF d.status<>'closed' THEN
    RETURN finnor_os.pe_declare_deal_closed_pre_v3(p_tenant,p_deal,p_expected_version,p_expected_graph_version,p_authority_decision,p_decision_receipt,p_source,p_actor);
  END IF;
  SELECT id,status INTO q FROM finnor_os.pe_closing_programmes WHERE tenant_id=p_tenant AND transaction_id=p_deal AND status NOT IN('STOPPED','FAILED','REOPENED') ORDER BY created_at DESC,id DESC LIMIT 1;
  IF q.id IS NULL OR q.status='CLOSED' THEN
    RETURN jsonb_build_object('changed',false,'idempotent',true,'row',to_jsonb(d),'eligibility',finnor_os.pe_evaluate_deal_close_eligibility(p_tenant,p_deal));
  END IF;
  IF p_expected_version IS NULL OR p_expected_graph_version IS NULL OR d.version<>p_expected_version OR d.graph_version<>p_expected_graph_version THEN RAISE EXCEPTION 'stale PE Deal close version'; END IF;
  eligibility:=finnor_os.pe_evaluate_deal_close_eligibility(p_tenant,p_deal);
  IF NOT (eligibility->>'eligible')::boolean THEN
    RETURN jsonb_build_object('changed',false,'idempotent',false,'rejected',true,'row',to_jsonb(d),'eligibility',eligibility);
  END IF;
  PERFORM finnor_os.pe_v3_issue_closed_certificate(p_tenant,p_deal,p_authority_decision,p_decision_receipt);
  RETURN jsonb_build_object('changed',false,'idempotent',false,'requalified',true,'row',to_jsonb(d),'eligibility',eligibility);
END $$;
REVOKE ALL ON FUNCTION finnor_os.pe_declare_deal_closed(uuid,uuid,integer,integer,uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.pe_declare_deal_closed(uuid,uuid,integer,integer,uuid,uuid,text,text) TO finnor_app;

-- Close publication and provider egress share one short, transaction-scoped
-- material fence. Invocation markers are intentionally excluded: they commit
-- independently before egress, while the broker serializes financial effects.
CREATE FUNCTION finnor_os.pe_v3_material_write_fence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid;
BEGIN
  IF TG_LEVEL='STATEMENT' THEN
    t:=finnor_os.request_tenant_id();
    IF t IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('v3-material-cut:'||t::text,0));
    END IF;
    RETURN NULL;
  END IF;
  t:=CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  PERFORM pg_advisory_xact_lock(hashtextextended('v3-material-cut:'||t::text,0));
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY[
    'pe_closing_profiles','pe_closing_programmes','pe_closing_node_links','pe_closing_evidence_bindings',
    's6_closing_duty_handoffs','authority_states','authority_decisions','authority_approval_requests',
    'users','employee_roles','employee_role_assignments','role_authority_grants',
    'works','work_inputs','work_plan_revisions','work_objective_loops',
    'pe_deals','pe_closing_conditions','pe_closing_items',
    'documents','document_versions','document_version_contents','document_version_heads',
    'evidence_sources','evidence_source_versions','p4_source_revisions','tasks','tenant_integrations',
    's5_proposals','s5_resources','s5_resource_heads','s5_reservations','s5_reservation_origins',
    's5_consumptions','s5_consumption_states','domain_actions','business_effects','external_operations',
    'workflow_runs','workflow_steps','commands'
  ] LOOP
    -- The authenticated statement fence runs before tuple locks. The row fence
    -- also protects administrative writes lacking a tenant session context.
    EXECUTE format('CREATE TRIGGER aa_v3_material_statement_fence BEFORE INSERT OR UPDATE OR DELETE ON finnor_os.%I
      FOR EACH STATEMENT EXECUTE FUNCTION finnor_os.pe_v3_material_write_fence()',tab);
    EXECUTE format('CREATE TRIGGER aa_v3_material_write_fence BEFORE INSERT OR UPDATE OR DELETE ON finnor_os.%I
      FOR EACH ROW EXECUTE FUNCTION finnor_os.pe_v3_material_write_fence()',tab);
  END LOOP;
END $$;

INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
  VALUES('advance_closing_programme_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
    'V3 maintained closing controller; exact canonical children retain S6/S5 responsibility. Not inherited protocol-3 programme semantics.');
