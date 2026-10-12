-- Responsible-principal metadata is native currentness, never execution permission.
CREATE OR REPLACE FUNCTION finnor_os.x1_lock_source_authority(w uuid,grant_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id(); u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
 IF grant_ids IS NULL OR cardinality(grant_ids)>16 THEN RAISE EXCEPTION 'X1_SOURCE_LOCK_SCOPE_BOUND'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text,5510));
 PERFORM 1 FROM finnor_os.works work JOIN finnor_os.users actor ON actor.tenant_id=work.tenant_id AND actor.id=work.created_by
  WHERE work.tenant_id=t AND work.id=w AND work.created_by=u AND actor.status='active' AND actor.role='owner'
  FOR SHARE OF work,actor;
 IF NOT FOUND THEN RAISE EXCEPTION 'X1_CURRENT_WORK_INPUT_OWNER_REQUIRED'; END IF;
 PERFORM 1 FROM finnor_os.x1_work_mandates m WHERE m.tenant_id=t AND m.work_id=w AND m.principal_id=u
  AND m.revoked_at IS NULL FOR SHARE OF m;
 PERFORM 1 FROM finnor_os.users responsible WHERE responsible.tenant_id=t AND responsible.id IN
  (SELECT DISTINCT (rule->>'principalId')::uuid FROM finnor_os.x1_work_mandates m,
    LATERAL jsonb_array_elements(m.rules) rule WHERE m.tenant_id=t AND m.work_id=w AND m.principal_id=u
    AND m.revoked_at IS NULL AND m.valid_from<=clock_timestamp() AND m.expires_at>clock_timestamp())
  FOR SHARE OF responsible;
 PERFORM 1 FROM finnor_os.x1_source_grants g WHERE g.tenant_id=t AND g.work_id=w AND g.principal_id=u
  AND g.id=ANY(grant_ids) FOR SHARE OF g;
 PERFORM 1 FROM finnor_os.x1_subject_identity_bindings b JOIN finnor_os.x1_source_grants g
  ON g.tenant_id=b.tenant_id AND g.source_id=b.source_id AND g.institution_id=b.institution_id
  WHERE g.tenant_id=t AND g.work_id=w AND g.principal_id=u AND g.id=ANY(grant_ids) FOR SHARE OF b;
 PERFORM 1 FROM finnor_os.x1_subject_consents c JOIN finnor_os.x1_subject_identity_bindings b
  ON b.tenant_id=c.tenant_id AND b.subject_user_id=c.subject_user_id AND b.institution_id=c.institution_id
  JOIN finnor_os.x1_source_grants g ON g.tenant_id=b.tenant_id AND g.source_id=b.source_id
   AND g.institution_id=b.institution_id AND g.source_class=c.source_class AND g.purpose=c.purpose
  JOIN finnor_os.users subject ON subject.tenant_id=c.tenant_id AND subject.id=c.subject_user_id
  WHERE g.tenant_id=t AND g.work_id=w AND g.principal_id=u AND g.id=ANY(grant_ids) FOR SHARE OF c,subject;
END $$;
REVOKE ALL ON FUNCTION finnor_os.x1_lock_source_authority(uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.x1_lock_source_authority(uuid,uuid[]) TO finnor_app,finnor_worker;


CREATE FUNCTION finnor_os.x1_responsible_principal_scope(w uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id(); u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
 current_rules jsonb; result jsonb;
BEGIN
 PERFORM 1 FROM finnor_os.works work JOIN finnor_os.users actor ON actor.tenant_id=work.tenant_id AND actor.id=work.created_by
  WHERE work.tenant_id=t AND work.id=w AND work.created_by=u AND actor.status='active' AND actor.role='owner';
 IF NOT FOUND THEN RAISE EXCEPTION 'X1_CURRENT_WORK_INPUT_OWNER_REQUIRED'; END IF;
 SELECT m.rules INTO current_rules FROM finnor_os.x1_work_mandates m WHERE m.tenant_id=t AND m.work_id=w
  AND m.principal_id=u AND m.revoked_at IS NULL AND m.valid_from<=clock_timestamp() AND m.expires_at>clock_timestamp()
  ORDER BY m.created_at DESC,m.id DESC LIMIT 1;
 IF current_rules IS NULL THEN RAISE EXCEPTION 'X1_CURRENT_MANDATE_UNAVAILABLE'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('principalId',r.id,'active',coalesce(person.status='active',false),
  'status',person.status,'role',person.role) ORDER BY r.id),'[]'::jsonb) INTO result
  FROM (SELECT DISTINCT rule->>'principalId' id FROM jsonb_array_elements(current_rules) rule) r
  LEFT JOIN finnor_os.users person ON person.tenant_id=t AND person.id::text=r.id;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION finnor_os.x1_responsible_principal_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.x1_responsible_principal_scope(uuid) TO finnor_app,finnor_worker;

CREATE FUNCTION finnor_os.x1_assert_responsible_principals(w uuid,pins jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF pins IS NULL OR jsonb_typeof(pins)<>'array' OR jsonb_array_length(pins) NOT BETWEEN 1 AND 128
  OR pins IS DISTINCT FROM finnor_os.x1_responsible_principal_scope(w)
 THEN RAISE EXCEPTION 'X1_RESPONSIBLE_PRINCIPAL_SCOPE_CHANGED'; END IF;
END $$;
REVOKE ALL ON FUNCTION finnor_os.x1_assert_responsible_principals(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.x1_assert_responsible_principals(uuid,jsonb) TO finnor_app,finnor_worker;

-- Revalidate the native responsible population in the final canonical mutation.
CREATE OR REPLACE FUNCTION finnor_os.x1_assert_effect_current(p_action uuid,p_method text DEFAULT NULL)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id(); u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
 a record; p record; x record; e record; node jsonb; grant_row record; rights text; subject jsonb; subject_count integer;
BEGIN
 SELECT * INTO a FROM finnor_os.domain_actions WHERE tenant_id=t AND id=p_action;
 IF a IS NULL OR a.authority_context->>'kind' IS DISTINCT FROM 'institution_duty' THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('s5-portfolio:'||t::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text,5510));
 IF u IS NULL OR a.initiated_by IS DISTINCT FROM u OR a.work_id IS NULL
  OR a.action_type NOT IN('create_deal_request','open_workstream','record_finding')
  OR EXISTS(SELECT 1 FROM finnor_os.s6_obligation_origins WHERE tenant_id=t AND domain_action_id=a.id)
 THEN RAISE EXCEPTION 'X1 ordinary effect scope or governed origin changed'; END IF;
 SELECT * INTO p FROM finnor_os.p1_requests WHERE tenant_id=t AND principal_id=u
  AND id=(a.authority_context->>'programId')::uuid AND work_id=a.work_id FOR SHARE;
 IF p IS NULL OR p.request->>'kind'<>'institution_responsibility_v1'
  OR p.status NOT IN('RUNNING','WAITING','PARTIAL') OR a.status<>'executing'
  OR p.work_input_id IS DISTINCT FROM (SELECT id FROM finnor_os.work_inputs
    WHERE tenant_id=t AND work_id=a.work_id ORDER BY created_at DESC,id DESC LIMIT 1)
  OR NOT EXISTS(SELECT 1 FROM finnor_os.work_plan_revisions WHERE tenant_id=t
    AND id=p.plan_revision_id AND work_input_id=p.work_input_id AND status='active')
 THEN RAISE EXCEPTION 'X1 programme, Work or active plan changed'; END IF;
 SELECT n INTO node FROM jsonb_array_elements(p.proposed->'nodes') n
  WHERE n->>'stableIdentity'=a.authority_context->>'stableIdentity'
   AND n->'action'->>'expectedEntityId'=a.id::text;
 IF node IS NULL OR node->>'operation'<>a.action_type
  OR (node->>'deadlineAt')::timestamptz<=clock_timestamp()
  OR (p.proposed->'bounds'->>'deadlineAt')::timestamptz<=clock_timestamp()
  OR (a.payload-'workId'-'grounding') IS DISTINCT FROM node->'action'->'payload'
  OR a.payload->>'workId' IS DISTINCT FROM a.work_id::text
  OR a.payload->'grounding'->'work'->>'entityId' IS DISTINCT FROM a.work_id::text
  OR a.payload->'grounding'->'deal'->>'entityId' IS DISTINCT FROM a.payload->>'dealId'
 THEN RAISE EXCEPTION 'X1 frozen ordinary intent or original deadline changed'; END IF;
 PERFORM 1 FROM finnor_os.users WHERE tenant_id=t AND id=u AND role='owner' AND status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'X1 current principal is unavailable'; END IF;
 PERFORM 1 FROM finnor_os.users WHERE tenant_id=t
  AND id=(node->'action'->'payload'->'owner'->>'partyId')::uuid AND status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'X1 responsible employee was revoked'; END IF;
 SELECT revision::text INTO rights FROM finnor_os.authority_states WHERE tenant_id=t FOR SHARE;
 PERFORM finnor_os.x1_lock_source_authority(a.work_id,
  ARRAY(SELECT (value->>'grantId')::uuid FROM jsonb_array_elements(p.request->'institution'->'programme'->'sourceScopes')));
 PERFORM finnor_os.x1_assert_responsible_principals(a.work_id,p.request->'institution'->'programme'->'responsiblePrincipals');
 PERFORM finnor_os.x1_assert_source_scopes(a.work_id,p.request->'institution'->'programme'->'sourceScopes',
  ARRAY(SELECT (value->>'grantId')::uuid FROM jsonb_array_elements(p.request->'institution'->'programme'->'sourceScopes')));
 IF p.request->'institution'->>'compilerRequestId' IS NOT NULL THEN
  SELECT * INTO x FROM finnor_os.x1_compiler_requests WHERE tenant_id=t AND principal_id=u
   AND id=(p.request->'institution'->>'compilerRequestId')::uuid AND work_id=a.work_id FOR SHARE;
  IF x IS NULL OR x.status NOT IN('RUNNING','WAITING','PARTIAL')
   OR x.work_input_id<>p.work_input_id
   OR x.input_manifest->'current'->>'rightsRevision' IS DISTINCT FROM rights
   OR p_method IS NULL OR x.input_manifest->'current'->>'methodRevision' IS DISTINCT FROM p_method
   OR x.admission_id IS NULL THEN RAISE EXCEPTION 'X1 compiler continuation was fenced'; END IF;
  PERFORM finnor_os.x1_assert_responsible_principals(a.work_id,x.input_manifest->'current'->'responsiblePrincipals');
  PERFORM finnor_os.x1_assert_canonical_owner_cut(x.input_manifest->'current'->'canonicalOwners',true);
  SELECT * INTO e FROM finnor_os.x1_compiler_episodes WHERE tenant_id=t AND principal_id=u AND id=x.episode_id FOR SHARE;
  IF e IS NULL OR e.wall_deadline<=clock_timestamp()
   OR e.parent_reservation IS DISTINCT FROM p.request->'institution'->'reservationRef'
  THEN RAISE EXCEPTION 'X1 original parent envelope expired or changed'; END IF;
  IF (SELECT count(*) FROM finnor_os.x1_source_grants WHERE tenant_id=t AND principal_id=u AND work_id=a.work_id AND id IN(SELECT value::uuid FROM jsonb_array_elements_text(x.grant_ids)))<>jsonb_array_length(x.grant_ids) THEN RAISE EXCEPTION 'X1 source population changed'; END IF;
  PERFORM finnor_os.x1_assert_source_scopes(a.work_id,x.input_manifest->'current'->'sourceScopes',
   ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(x.grant_ids)));
  FOR grant_row IN SELECT * FROM finnor_os.x1_source_grants g
   WHERE g.tenant_id=t AND g.principal_id=u AND g.work_id=a.work_id
    AND g.id IN(SELECT value::uuid FROM jsonb_array_elements_text(x.grant_ids)) FOR SHARE OF g LOOP
   IF x.input_manifest->'current'->'sourceRevisions'->>grant_row.source_id IS DISTINCT FROM grant_row.revision
    OR EXISTS(SELECT 1 FROM finnor_os.x1_source_grants newer WHERE newer.tenant_id=t
      AND newer.principal_id=u AND newer.work_id=a.work_id AND newer.source_id=grant_row.source_id AND newer.version>grant_row.version)
   THEN RAISE EXCEPTION 'X1 source grant changed before canonical mutation'; END IF;
  END LOOP;
  FOR subject IN SELECT value FROM jsonb_array_elements(coalesce(x.input_manifest->'current'->'sensitiveSubjects','[]'::jsonb)) LOOP
   PERFORM 1 FROM finnor_os.x1_subject_identity_bindings b JOIN finnor_os.x1_subject_consents co
    ON co.tenant_id=b.tenant_id AND co.subject_user_id=b.subject_user_id AND co.institution_id=b.institution_id
    AND co.source_class=subject->>'sourceClass' AND co.purpose=subject->>'purpose'
    JOIN finnor_os.users u ON u.tenant_id=b.tenant_id AND u.id=b.subject_user_id
    WHERE b.tenant_id=t AND b.institution_id=subject->>'institutionId' AND b.source_id=subject->>'sourceId'
     AND b.registration_id IN(SELECT value FROM jsonb_array_elements_text(subject->'registrations'))
     AND b.revoked_at IS NULL AND b.valid_from<=clock_timestamp() AND b.expires_at>clock_timestamp()
     AND co.revoked_at IS NULL AND co.granted_at<=clock_timestamp() AND co.expires_at>clock_timestamp()
     AND u.status='active' FOR SHARE OF b,co,u;
   GET DIAGNOSTICS subject_count = ROW_COUNT;
   IF subject_count<>jsonb_array_length(subject->'registrations') THEN RAISE EXCEPTION 'X1 consent or subject identity changed before mutation'; END IF;
  END LOOP;
  PERFORM 1 FROM finnor_os.x1_work_mandates m WHERE m.tenant_id=t AND m.principal_id=u AND m.work_id=a.work_id
   AND m.revoked_at IS NULL AND m.valid_from<=clock_timestamp() AND m.expires_at>clock_timestamp()
   AND m.revision=x.input_manifest->'current'->>'mandateRevision' FOR SHARE OF m;
  IF NOT FOUND THEN RAISE EXCEPTION 'X1 standing mandate changed before canonical mutation'; END IF;
 END IF;
 PERFORM 1 FROM finnor_os.s5_reservations r JOIN finnor_os.s5_reservation_origins o USING(tenant_id,reservation_id)
  WHERE r.tenant_id=t AND o.principal_id=u AND r.reservation_id=p.request->'institution'->'reservationRef'->>'id'
   AND r.status<>'RELEASED' AND r.revocation_reason IS NULL
   FOR SHARE OF r,o;
 IF NOT FOUND THEN RAISE EXCEPTION 'X1 original S5 reservation changed before canonical mutation'; END IF;
 PERFORM finnor_os.s5_assert_institution_current(p.request->'institution'->'reservationRef'->>'id',NULL);
END $$;
