-- Current native authority may revalidate an immutable original S5 frame.
-- This is resource accounting only; it neither grants execution nor rewrites it.
CREATE FUNCTION finnor_os.s5_assert_institution_current(reservation text,decision uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id(); u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
 origin jsonb; epoch integer; actual_decision uuid:=decision;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('s5-portfolio:'||t::text,0));
 SELECT o.body INTO origin FROM finnor_os.s5_reservation_origins o JOIN finnor_os.s5_reservations s
  USING(tenant_id,reservation_id) WHERE o.tenant_id=t AND o.principal_id=u AND o.reservation_id=reservation
   AND o.body->>'schema'='finnor.s5.institution-reservation.v1' AND s.status<>'RELEASED'
   AND s.revocation_reason IS NULL FOR SHARE OF o,s;
 IF origin IS NULL OR origin->>'tenantId' IS DISTINCT FROM t::text OR origin->>'principalId' IS DISTINCT FROM u::text
   OR origin->'demand'->>'workId' IS DISTINCT FROM origin->>'workId'
   OR origin->'demand'->>'originalDeadline' IS DISTINCT FROM origin->>'originalDeadline'
   OR origin->'demand'->>'qualification' IS DISTINCT FROM 'DECLARED_ACCOUNTING_NOT_FUNDING'
   OR origin->'executionAuthorityGranted' IS DISTINCT FROM 'false'::jsonb
   OR (origin->>'originalDeadline')::timestamptz<=clock_timestamp() THEN
  RAISE EXCEPTION 'S5 immutable original institution frame unavailable';
 END IF;
 PERFORM finnor_os.x1_lock_source_authority((origin->>'workId')::uuid,ARRAY[]::uuid[]);
 SELECT revision INTO epoch FROM finnor_os.authority_states WHERE tenant_id=t FOR SHARE;
 IF actual_decision IS NULL THEN
  SELECT a.id INTO actual_decision FROM finnor_os.authority_decisions a WHERE a.tenant_id=t AND a.employee_id=u
   AND a.work_id=(origin->>'workId')::uuid AND a.authority_revision=epoch AND a.operation='query'
   AND a.capability='query:pe_world_state' AND a.risk='low' AND a.outcome='allowed' AND a.reason_code='grant_allows'
   AND a.created_at>clock_timestamp()-interval '30 seconds'
   AND a.evidence->'resources'=jsonb_build_array(jsonb_build_object('type','work','id',origin->>'workId'))
   ORDER BY a.created_at DESC,a.id DESC LIMIT 1;
 END IF;
 IF actual_decision IS NULL THEN RAISE EXCEPTION 'S5 fresh native institution authority decision required'; END IF;
 PERFORM finnor_os.x1_assert_input_decision((origin->>'workId')::uuid,NULL,actual_decision);
 PERFORM 1 FROM finnor_os.x1_work_mandates m WHERE m.tenant_id=t AND m.work_id=(origin->>'workId')::uuid
  AND m.principal_id=u AND m.institution_id=origin->'demand'->>'institutionId' AND m.revoked_at IS NULL
  AND m.valid_from<=clock_timestamp() AND m.expires_at>clock_timestamp()
  AND (SELECT min(rule->>'deadlineAt') FROM jsonb_array_elements(m.rules) rule)=origin->>'originalDeadline';
 IF NOT FOUND THEN RAISE EXCEPTION 'S5 original institution mandate deadline unavailable'; END IF;
 PERFORM 1 FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision)
  WHERE r.tenant_id=t FOR SHARE OF r,h;
 IF origin->'resources' IS DISTINCT FROM (SELECT coalesce(jsonb_agg(r.body->'ref' ORDER BY r.resource_id),'[]'::jsonb)
  FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision) WHERE r.tenant_id=t)
  OR EXISTS(SELECT 1 FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision)
   WHERE r.tenant_id=t AND (r.body->'revoked' IS DISTINCT FROM 'false'::jsonb
    OR r.body->>'validUntil' IS NULL OR (r.body->>'validUntil')::timestamptz<=clock_timestamp())) THEN
  RAISE EXCEPTION 'S5 original institution resources changed';
 END IF;
 RETURN jsonb_build_object('schema','finnor.s5.institution-currentness.v1','reservationRef',origin->'ref',
  'originalRightsRevision',origin->>'rightsRevision','rightsRevision',epoch::text,'authorityDecisionId',actual_decision,
  'originalDeadline',origin->>'originalDeadline','resources',origin->'resources',
  'scope','RESOURCE_ACCOUNTING_ONLY','executionAuthorityGranted',false);
END $$;
REVOKE ALL ON FUNCTION finnor_os.s5_assert_institution_current(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.s5_assert_institution_current(text,uuid) TO finnor_app,finnor_worker;

CREATE OR REPLACE FUNCTION finnor_os.s5_consume_institution(p_reservation_id text,p_body jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE v_tenant uuid:=finnor_os.request_tenant_id();
  v_user uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  v_origin jsonb; v_status text; v_prior jsonb; v_used numeric; v_limit numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('s5-portfolio:'||v_tenant::text,0));
  SELECT o.body,s.status INTO v_origin,v_status FROM finnor_os.s5_reservation_origins o
    JOIN finnor_os.s5_reservations s USING(tenant_id,reservation_id)
    WHERE o.tenant_id=v_tenant AND o.principal_id=v_user AND o.reservation_id=p_reservation_id
      AND o.body->>'schema'='finnor.s5.institution-reservation.v1' FOR UPDATE OF s;
  IF p_body->>'currentAuthorityDecisionId' IS NULL THEN RAISE EXCEPTION 'S5 current native decision receipt required'; END IF;
  PERFORM finnor_os.s5_assert_institution_current(p_reservation_id,(p_body->>'currentAuthorityDecisionId')::uuid);
  IF p_body->>'currentRightsRevision' IS DISTINCT FROM (SELECT revision::text FROM finnor_os.authority_states WHERE tenant_id=v_tenant)
   THEN RAISE EXCEPTION 'S5 current native decision epoch changed'; END IF;
  IF v_origin IS NULL OR v_status='RELEASED' OR p_body->>'schema'<>'finnor.s5.institution-consumption.v1'
    OR p_body->'reservationRef'<>v_origin->'ref'
    OR p_body->>'originalDeadline'<>v_origin->>'originalDeadline'
    OR p_body->>'parentWorkId'<>v_origin->>'workId'
    OR p_body->'ref'->>'owner'<>'S5'
    OR p_body->'ref'->>'id' IS NULL
    OR (v_origin->>'originalDeadline')::timestamptz<=clock_timestamp()
    OR v_origin->'resources' IS DISTINCT FROM (
      SELECT coalesce(jsonb_agg(r.body->'ref' ORDER BY r.resource_id),'[]'::jsonb)
      FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h
        USING(tenant_id,resource_id,revision) WHERE r.tenant_id=v_tenant)
    OR NOT EXISTS(SELECT 1 FROM finnor_os.x1_work_mandates m
      WHERE m.tenant_id=v_tenant AND m.work_id=(v_origin->>'workId')::uuid
        AND m.principal_id=v_user AND m.institution_id=v_origin->'demand'->>'institutionId'
        AND m.revoked_at IS NULL AND m.valid_from<=clock_timestamp()
        AND m.expires_at>clock_timestamp()
        AND (SELECT min(rule->>'deadlineAt') FROM jsonb_array_elements(m.rules) rule)
          =v_origin->>'originalDeadline')
    OR NOT finnor_os.x1_s5_charge_authorized(v_origin,p_body->>'responsibilityIdentity')
  THEN RAISE EXCEPTION 'S5 institution consumption not current'; END IF;
  IF p_body->>'chargeKey'<>('x1-charge:'||encode(sha256(convert_to(replace(
      jsonb_build_array(v_origin->'demand'->>'demandDigest',p_body->>'responsibilityIdentity',
        p_body->>'phase',(p_body->>'ordinal')::integer)::text,', ',','),'UTF8')),'hex'))
    OR p_body->>'requestDigest'<>encode(sha256(convert_to(replace(
      jsonb_build_array('institution-charge-request-v1',v_origin->'demand'->>'demandDigest',
        p_body->>'responsibilityIdentity',p_body->>'phase',
        (p_body->>'ordinal')::integer,(p_body->>'units')::integer)::text,', ',','),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'S5 institution charge semantic identity mismatch'; END IF;
  SELECT body INTO v_prior FROM finnor_os.s5_consumptions
    WHERE tenant_id=v_tenant AND principal_id=v_user AND idempotency_key=p_body->>'chargeKey';
  IF FOUND THEN
    IF v_prior<>p_body THEN RAISE EXCEPTION 'S5 institution charge replay conflict'; END IF;
    RETURN v_prior;
  END IF;
  IF (SELECT count(*) FROM finnor_os.s5_consumptions
    WHERE tenant_id=v_tenant AND reservation_id=p_reservation_id)>=(CASE
      WHEN v_origin->'demand'->'chargeScope' IS NULL THEN 512 ELSE 1420 END)
    THEN RAISE EXCEPTION 'S5 institution original charge bound exhausted'; END IF;
  SELECT COALESCE(sum(units),0) INTO v_used FROM finnor_os.s5_governed_resource_charges
    WHERE tenant_id=v_tenant AND reservation_id=p_reservation_id AND resource_id=p_body->>'resourceId';
  SELECT max((e->'quantities'->>0)::numeric) INTO v_limit
    FROM jsonb_array_elements(v_origin->'envelopes') e
    WHERE e->>'resourceId'=p_body->>'resourceId' AND e->>'unit'=p_body->>'unit';
  IF v_limit IS NULL OR (p_body->>'units')::integer NOT BETWEEN 1 AND 100000
    OR (p_body->>'phase') NOT IN ('EXECUTION','RECOVERY','HUMAN','ACQUISITION','CHECK','COMPILE')
    OR (p_body->>'ordinal')::integer NOT BETWEEN 1 AND (CASE
      WHEN v_origin->'demand'->'chargeScope' IS NULL THEN 64
      WHEN p_body->>'phase'='RECOVERY' THEN LEAST(1024,coalesce((SELECT max_steps FROM finnor_os.p1_episodes
        WHERE tenant_id=v_tenant AND principal_id=v_user AND work_id=(v_origin->>'workId')::uuid),128))
      ELSE 128 END)
    OR v_used+(p_body->>'units')::integer>v_limit
    OR (p_body->>'phase'='HUMAN' AND p_body->>'unit'<>'seconds')
    OR (p_body->>'phase'<>'HUMAN' AND p_body->>'unit'<>'request')
    OR NOT EXISTS(SELECT 1 FROM finnor_os.s5_resources r
      JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision)
      WHERE r.tenant_id=v_tenant AND r.resource_id=p_body->>'resourceId'
        AND r.body->>'resourceClass'=CASE WHEN p_body->>'phase'='HUMAN'
          THEN 'HUMAN_ATTENTION' ELSE 'COMPUTE' END
        AND (r.body->>'revoked')::boolean=false
        AND (r.body->>'validUntil')::timestamptz>clock_timestamp())
    OR p_body->>'usedAfter'<>(v_used+(p_body->>'units')::integer)::text
  THEN RAISE EXCEPTION 'S5 institution original parent charge exceeds envelope'; END IF;
  INSERT INTO finnor_os.s5_consumptions(tenant_id,principal_id,consumption_id,reservation_id,
    policy_id,node_id,idempotency_key,request_digest,body)
    VALUES(v_tenant,v_user,p_body->'ref'->>'id',p_reservation_id,
      p_body->>'responsibilityIdentity',p_body->>'chargeKey',p_body->>'chargeKey',
      p_body->>'requestDigest',p_body);
  INSERT INTO finnor_os.s5_consumption_states(tenant_id,consumption_id,status,revision)
    VALUES(v_tenant,p_body->'ref'->>'id','INTENDED_PENDING_S6',1);
  INSERT INTO finnor_os.s5_governed_resource_charges(tenant_id,principal_id,reservation_id,
    consumption_id,charge_key,phase,resource_id,unit,units,request_digest,body)
    VALUES(v_tenant,v_user,p_reservation_id,p_body->'ref'->>'id',p_body->>'chargeKey',
      p_body->>'phase',p_body->>'resourceId',p_body->>'unit',
      (p_body->>'units')::integer,p_body->>'requestDigest',p_body);
  UPDATE finnor_os.s5_reservations SET status='CONSUMPTION_PENDING',revision=revision+1
    WHERE tenant_id=v_tenant AND reservation_id=p_reservation_id AND status='RESERVED';
  RETURN p_body;
END $$;

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
 IF p.request->'institution'->>'compilerRequestId' IS NOT NULL THEN
  SELECT * INTO x FROM finnor_os.x1_compiler_requests WHERE tenant_id=t AND principal_id=u
   AND id=(p.request->'institution'->>'compilerRequestId')::uuid AND work_id=a.work_id FOR SHARE;
  IF x IS NULL OR x.status NOT IN('RUNNING','WAITING','PARTIAL')
   OR x.work_input_id<>p.work_input_id
   OR x.input_manifest->'current'->>'rightsRevision' IS DISTINCT FROM rights
   OR p_method IS NULL OR x.input_manifest->'current'->>'methodRevision' IS DISTINCT FROM p_method
   OR x.admission_id IS NULL THEN RAISE EXCEPTION 'X1 compiler continuation was fenced'; END IF;
  PERFORM finnor_os.x1_assert_canonical_owner_cut(x.input_manifest->'current'->'canonicalOwners',true);
  SELECT * INTO e FROM finnor_os.x1_compiler_episodes WHERE tenant_id=t AND principal_id=u AND id=x.episode_id FOR SHARE;
  IF e IS NULL OR e.wall_deadline<=clock_timestamp()
   OR e.parent_reservation IS DISTINCT FROM p.request->'institution'->'reservationRef'
  THEN RAISE EXCEPTION 'X1 original parent envelope expired or changed'; END IF;
  IF (SELECT count(*) FROM finnor_os.x1_source_grants WHERE tenant_id=t AND principal_id=u AND work_id=a.work_id AND id IN(SELECT value::uuid FROM jsonb_array_elements_text(x.grant_ids)))<>jsonb_array_length(x.grant_ids) THEN RAISE EXCEPTION 'X1 source population changed'; END IF;
  FOR grant_row IN SELECT * FROM finnor_os.x1_source_grants g
   WHERE g.tenant_id=t AND g.principal_id=u AND g.work_id=a.work_id
    AND g.id IN(SELECT value::uuid FROM jsonb_array_elements_text(x.grant_ids)) FOR SHARE OF g LOOP
   IF grant_row.revoked_at IS NOT NULL OR grant_row.valid_from>clock_timestamp() OR grant_row.expires_at<=clock_timestamp()
    OR x.input_manifest->'current'->'sourceRevisions'->>grant_row.source_id IS DISTINCT FROM grant_row.revision
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
