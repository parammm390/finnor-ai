-- Coordinator integration input, NOT an applied migration or an access grant.
-- Install after the existing X1/X2 migrations using the canonical DB owner.
-- Existing institution owner guards, RLS, occupancy and immutable history stay.
-- No reservation, resource, allowance, release or effect-dispatch writer is added.

CREATE FUNCTION finnor_os.z0_s5_application_frame(p_ref jsonb,p_decision uuid,p_recovery boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id();
 u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
 cert jsonb; origin jsonb; parent jsonb; parent_status text; parent_envelopes jsonb;
 compiler finnor_os.x1_compiler_requests%ROWTYPE;
 programme finnor_os.p1_requests%ROWTYPE;
 episode finnor_os.x1_compiler_episodes%ROWTYPE;
 duty jsonb; duties integer; line jsonb; original_line jsonb; requested jsonb;
 subject jsonb; subject_count integer;
BEGIN
 IF t IS NULL OR u IS NULL OR NOT EXISTS(SELECT 1 FROM finnor_os.users
  WHERE tenant_id=t AND id=u AND status='active' AND role='owner')
  THEN RAISE EXCEPTION 'Z0 authenticated original owner required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('s5-portfolio:'||t::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text,5510));
 SELECT a.body INTO cert FROM finnor_os.application_semantics_artifacts a
  WHERE a.tenant_id=t AND a.principal_id=u AND a.artifact_id=p_ref->>'id'
   AND a.semantic_owner='S5' AND a.version='application-operation-v1'
   AND a.content_digest=p_ref->>'contentDigest';
 IF cert IS NULL OR p_ref->>'owner' IS DISTINCT FROM 'S5'
  OR p_ref->>'version' IS DISTINCT FROM 'application-operation-v1'
  OR p_ref->>'id' IS DISTINCT FROM 'institution-application-allocation:'||(p_ref->>'contentDigest')
  OR cert->>'schema' IS DISTINCT FROM 'finnor.s5.application-allocation.v1'
  OR cert->>'occupation' IS DISTINCT FROM 'EXISTING_ORIGINAL_X1_RESERVATION_NO_NEW_FUNDING'
  OR cert->>'tenantId' IS DISTINCT FROM t::text OR cert->>'principalId' IS DISTINCT FROM u::text
  OR cert->'executionAuthorityGranted' IS DISTINCT FROM 'false'::jsonb
  OR jsonb_typeof(cert->'check'->'envelopes') IS DISTINCT FROM 'array'
  OR jsonb_typeof(cert->'acquisitionRequest'->'resourceDemand') IS DISTINCT FROM 'array'
  OR jsonb_typeof(cert->'resourceRefs') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'Z0 inherited allocation preimage unavailable'; END IF;
 SELECT a.body INTO origin FROM finnor_os.application_semantics_artifacts a
  WHERE a.tenant_id=t AND a.principal_id=u AND a.artifact_id=cert->'institutionalOriginRef'->>'id'
   AND a.semantic_owner='S4' AND a.version=cert->'institutionalOriginRef'->>'version'
   AND a.content_digest=cert->'institutionalOriginRef'->>'contentDigest';
 IF origin IS NULL OR origin->>'schema' IS DISTINCT FROM 'finnor.z0.institution-application-origin.v1'
  OR origin->>'tenantId' IS DISTINCT FROM t::text OR origin->>'principalId' IS DISTINCT FROM u::text
  OR origin->>'workId' IS DISTINCT FROM cert->>'workId'
  OR origin->>'deadlineAt' IS DISTINCT FROM cert->>'deadlineAt'
  OR origin->'originalReservationRef' IS DISTINCT FROM cert->'originalReservationRef'
  OR origin->>'purpose' IS DISTINCT FROM 'LEARN_APPLICATION_MODEL_THEN_RETURN_TO_ORIGINAL_P1'
  OR origin->'executionAuthorityGranted' IS DISTINCT FROM 'false'::jsonb
  OR origin->'protectedAdmission' IS DISTINCT FROM 'false'::jsonb
  OR cert->'acquisitionRequest'->'institutionalOrigin' IS DISTINCT FROM origin->'selector'
  OR cert->'acquisitionRequest'->>'workId' IS DISTINCT FROM origin->>'workId'
  OR cert->'acquisitionRequest'->'root' IS DISTINCT FROM origin->'root'
  OR cert->'acquisitionRequest'->>'deadlineAt' IS DISTINCT FROM origin->>'deadlineAt'
  THEN RAISE EXCEPTION 'Z0 original institution binding unavailable'; END IF;
 SELECT * INTO compiler FROM finnor_os.x1_compiler_requests
  WHERE tenant_id=t AND principal_id=u AND id=(origin->'selector'->>'compilerRequestId')::uuid FOR SHARE;
 SELECT * INTO programme FROM finnor_os.p1_requests
  WHERE tenant_id=t AND principal_id=u AND id=(origin->'selector'->>'programId')::uuid FOR SHARE;
 SELECT * INTO episode FROM finnor_os.x1_compiler_episodes
  WHERE tenant_id=t AND principal_id=u AND id=compiler.episode_id FOR SHARE;
 IF compiler.id IS NULL OR programme.id IS NULL OR episode.id IS NULL
  OR compiler.work_id IS DISTINCT FROM (origin->>'workId')::uuid
  OR programme.work_id IS DISTINCT FROM compiler.work_id
  OR compiler.work_input_id IS DISTINCT FROM (origin->>'workInputId')::uuid
  OR programme.work_input_id IS DISTINCT FROM compiler.work_input_id
  OR compiler.work_input_digest IS DISTINCT FROM origin->>'workInputDigest'
  OR programme.work_input_digest IS DISTINCT FROM compiler.work_input_digest
  OR origin->'root' IS DISTINCT FROM programme.request->'root'
  OR compiler.program_id IS DISTINCT FROM programme.id
  OR compiler.admission_id IS DISTINCT FROM (origin->>'admissionId')::uuid
  OR episode.id IS DISTINCT FROM (origin->>'compilerEpisodeId')::uuid
  OR episode.parent_reservation IS DISTINCT FROM origin->'originalReservationRef'
  OR episode.parent_demand->>'demandDigest' IS DISTINCT FROM origin->>'originalDemandDigest'
  OR programme.request->'institution'->'reservationRef' IS DISTINCT FROM episode.parent_reservation
  OR programme.request->'institution'->'demand' IS DISTINCT FROM episode.parent_demand
  OR programme.request->'institution'->>'compilerRequestId' IS DISTINCT FROM compiler.id::text
  OR origin->'institutionalProgramRef'->>'owner' IS DISTINCT FROM 'S4_P1'
  OR NOT EXISTS(SELECT 1 FROM finnor_os.x1_compiler_artifacts a WHERE a.tenant_id=t AND a.principal_id=u
    AND a.request_id=compiler.id AND a.id=compiler.artifact_id
    AND a.id::text=origin->'institutionalProgramRef'->>'id'
    AND a.body_digest=origin->'institutionalProgramRef'->>'contentDigest'
    AND a.body->'envelope'->>'schema_revision'=origin->'institutionalProgramRef'->>'version'
    AND a.check_result->>'disposition'='ACCEPTED_DEVELOPMENT')
  THEN RAISE EXCEPTION 'Z0 original owner/admission ancestry changed'; END IF;
 SELECT count(*),jsonb_agg(d.value)->0 INTO duties,duty
  FROM finnor_os.x1_checked_artifacts a CROSS JOIN LATERAL jsonb_array_elements(a.responsibilities) d(value)
  WHERE a.tenant_id=t AND a.principal_id=u AND a.work_id=compiler.work_id AND a.admission_id=compiler.admission_id
    AND d.value->'obligation'->>'stableIdentity'=origin->'selector'->>'responsibilityIdentity';
 IF duties<>1 OR duty->'obligation'->>'responsiblePrincipal' IS DISTINCT FROM u::text
  OR NOT (programme.request->'institution'->'responsibilities' @> jsonb_build_array(duty))
  THEN RAISE EXCEPTION 'Z0 checked original responsibility required'; END IF;
 SELECT o.body,s.status,s.envelopes INTO parent,parent_status,parent_envelopes FROM finnor_os.s5_reservation_origins o
  JOIN finnor_os.s5_reservations s USING(tenant_id,reservation_id)
  WHERE o.tenant_id=t AND o.principal_id=u AND o.reservation_id=episode.parent_reservation->>'id'
   AND o.body->>'schema'='finnor.s5.institution-reservation.v1' FOR UPDATE OF s;
 IF parent IS NULL OR parent_status='RELEASED'
  OR parent->'ref' IS DISTINCT FROM episode.parent_reservation
  OR parent->'envelopes' IS DISTINCT FROM parent_envelopes
  OR parent->>'workId' IS DISTINCT FROM origin->>'workId'
  OR parent->'demand'->>'demandDigest' IS DISTINCT FROM origin->>'originalDemandDigest'
  THEN RAISE EXCEPTION 'Z0 original resource occupation unavailable'; END IF;
 IF NOT p_recovery THEN
  IF p_decision IS NULL THEN RAISE EXCEPTION 'Z0 fresh original authority decision required'; END IF;
  PERFORM finnor_os.s5_assert_institution_current(parent->'ref'->>'id',p_decision);
  IF compiler.status NOT IN('WAITING','PARTIAL') OR programme.status NOT IN('WAITING','PARTIAL','FAILED')
   OR compiler.generation IS DISTINCT FROM (origin->>'compilerGeneration')::integer
   OR compiler.revision IS DISTINCT FROM (origin->>'compilerRevision')::integer
   OR programme.generation IS DISTINCT FROM (origin->>'programmeGeneration')::integer
   OR programme.episode_id IS DISTINCT FROM (origin->>'programmeEpisodeId')::uuid
   OR programme.plan_revision_id IS DISTINCT FROM (origin->>'planRevisionId')::uuid
   OR programme.request_digest IS DISTINCT FROM origin->>'programmeRequestDigest'
   OR NOT EXISTS(SELECT 1 FROM finnor_os.works w
      JOIN finnor_os.work_plan_revisions p ON p.tenant_id=w.tenant_id AND p.work_id=w.id
      WHERE w.tenant_id=t AND w.id=compiler.work_id AND w.created_by=u
        AND w.status NOT IN('completed','cancelled','failed')
        AND p.id=programme.plan_revision_id AND p.work_input_id=compiler.work_input_id AND p.status='active'
      FOR SHARE OF w,p)
   OR compiler.programme_digest IS DISTINCT FROM origin->>'programmeDigest'
   OR compiler.input_manifest->'current'->'sourceRevisions' IS DISTINCT FROM origin->'sourceRevisions'
   OR compiler.input_manifest->'current'->>'rightsRevision' IS DISTINCT FROM origin->>'rightsRevision'
   OR origin->>'rightsRevision' IS DISTINCT FROM (SELECT revision::text FROM finnor_os.authority_states WHERE tenant_id=t)
   OR (SELECT i.id FROM finnor_os.work_inputs i WHERE i.tenant_id=t AND i.work_id=compiler.work_id
     ORDER BY i.created_at DESC,i.id DESC LIMIT 1) IS DISTINCT FROM compiler.work_input_id
   OR EXISTS(SELECT 1 FROM finnor_os.x1_compiler_requests newer WHERE newer.tenant_id=t
      AND newer.principal_id=u AND newer.work_id=compiler.work_id AND newer.revision>compiler.revision)
   OR (cert->>'deadlineAt')::timestamptz<=clock_timestamp()
   OR (cert->>'deadlineAt')::timestamptz>LEAST(episode.original_deadline,episode.wall_deadline,
      (duty->'obligation'->>'originalDeadline')::timestamptz,
      (programme.proposed->'bounds'->>'deadlineAt')::timestamptz)
   OR NOT EXISTS(SELECT 1 FROM finnor_os.x1_work_mandates m WHERE m.tenant_id=t AND m.principal_id=u
      AND m.work_id=compiler.work_id AND m.revoked_at IS NULL AND m.valid_from<=clock_timestamp()
      AND m.expires_at>clock_timestamp() AND m.revision=origin->>'mandateRevision')
   THEN RAISE EXCEPTION 'Z0 original forward authority or deadline changed'; END IF;
  PERFORM finnor_os.x1_assert_responsible_principals(compiler.work_id,compiler.input_manifest->'current'->'responsiblePrincipals');
  PERFORM finnor_os.x1_assert_source_scopes(compiler.work_id,compiler.input_manifest->'current'->'sourceScopes',
    ARRAY(SELECT jsonb_array_elements_text(compiler.grant_ids)::uuid));
  PERFORM finnor_os.x1_assert_canonical_owner_cut(compiler.input_manifest->'current'->'canonicalOwners',true);
  FOR subject IN SELECT value FROM jsonb_array_elements(
    coalesce(compiler.input_manifest->'current'->'sensitiveSubjects','[]'::jsonb)) LOOP
   IF jsonb_typeof(subject->'registrations') IS DISTINCT FROM 'array'
     OR jsonb_array_length(subject->'registrations') NOT BETWEEN 1 AND 200
     THEN RAISE EXCEPTION 'Z0 original subject population required'; END IF;
   PERFORM 1 FROM finnor_os.x1_subject_identity_bindings b
    JOIN finnor_os.x1_subject_consents consent ON consent.tenant_id=b.tenant_id
      AND consent.subject_user_id=b.subject_user_id AND consent.institution_id=b.institution_id
      AND consent.source_class=subject->>'sourceClass' AND consent.purpose=subject->>'purpose'
    JOIN finnor_os.users actor ON actor.tenant_id=b.tenant_id AND actor.id=b.subject_user_id
    WHERE b.tenant_id=t AND b.institution_id=subject->>'institutionId' AND b.source_id=subject->>'sourceId'
      AND b.registration_id IN(SELECT value FROM jsonb_array_elements_text(subject->'registrations'))
      AND b.revoked_at IS NULL AND b.valid_from<=clock_timestamp() AND b.expires_at>clock_timestamp()
      AND consent.revoked_at IS NULL AND consent.granted_at<=clock_timestamp() AND consent.expires_at>clock_timestamp()
      AND actor.status='active' FOR SHARE OF b,consent,actor;
   GET DIAGNOSTICS subject_count = ROW_COUNT;
   IF subject_count<>jsonb_array_length(subject->'registrations')
     THEN RAISE EXCEPTION 'Z0 original subject consent changed'; END IF;
  END LOOP;
 ELSIF p_decision IS NOT NULL THEN
  -- Fresh permission to observe/account is not refreshed forward authority.
  PERFORM finnor_os.x1_assert_input_decision(compiler.work_id,NULL,p_decision);
 END IF;
 IF jsonb_array_length(cert->'check'->'envelopes') NOT BETWEEN 1 AND 2
  OR jsonb_array_length(cert->'acquisitionRequest'->'resourceDemand')<>jsonb_array_length(cert->'check'->'envelopes')
  OR (SELECT count(DISTINCT value->>'resourceId') FROM jsonb_array_elements(cert->'check'->'envelopes'))<>
    jsonb_array_length(cert->'check'->'envelopes')
  THEN RAISE EXCEPTION 'Z0 child envelope population invalid'; END IF;
 FOR line IN SELECT value FROM jsonb_array_elements(cert->'check'->'envelopes') LOOP
  SELECT value INTO original_line FROM jsonb_array_elements(parent->'envelopes')
    WHERE value->>'resourceId'=line->>'resourceId' AND value->>'unit'=line->>'unit';
  SELECT value INTO requested FROM jsonb_array_elements(cert->'acquisitionRequest'->'resourceDemand')
    WHERE value->>'resourceId'=line->>'resourceId' AND value->>'unit'=line->>'unit';
  IF original_line IS NULL OR requested IS NULL OR coalesce(line->>'unit','') NOT IN('request','seconds')
   OR line->>'kind' IS DISTINCT FROM 'CUMULATIVE_EXPENDITURE'
   OR jsonb_typeof(line->'quantities') IS DISTINCT FROM 'array'
   OR line->'horizon' IS DISTINCT FROM original_line->'horizon'
   OR jsonb_array_length(line->'quantities')<>jsonb_array_length(original_line->'quantities')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(line->'quantities') WITH ORDINALITY q(value,n)
     WHERE q.value !~ '^(0|[1-9][0-9]{0,15})$'
       OR q.value::numeric>(original_line->'quantities'->>(q.n::integer-1))::numeric)
   OR coalesce(requested->>'amount','') !~ '^[1-9][0-9]{0,3}$'
   OR (requested->>'amount')::numeric>(CASE WHEN line->>'unit'='seconds' THEN 900 ELSE 2048 END)
   OR (SELECT sum(value::numeric) FROM jsonb_array_elements_text(line->'quantities'))<>(requested->>'amount')::numeric
   THEN RAISE EXCEPTION 'Z0 child envelope enlarges original resource'; END IF;
 END LOOP;
 RETURN jsonb_build_object('certificate',cert,'origin',origin,'parent',parent);
END $$;
REVOKE ALL ON FUNCTION finnor_os.z0_s5_application_frame(jsonb,uuid,boolean) FROM PUBLIC;

CREATE FUNCTION finnor_os.z0_s5_application_consumption(p_body jsonb,p_decision uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id(); u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
 frame jsonb; cert jsonb; parent jsonb; prior jsonb;
BEGIN
 frame:=finnor_os.z0_s5_application_frame(p_body->'certificateRef',p_decision,false);
 cert:=frame->'certificate'; parent:=frame->'parent';
 IF p_body->>'schema' IS DISTINCT FROM 'finnor.s5.application-consumption.v1'
  OR p_body->'reservationRef' IS DISTINCT FROM parent->'ref'
  OR p_body->'originalParentRef' IS DISTINCT FROM cert->'originalParentRef'
  OR p_body->'envelope' IS DISTINCT FROM parent->'envelopes'
  OR p_body->>'status' IS DISTINCT FROM 'INTENDED_PENDING_S6'
  OR p_body->'effectRef' IS DISTINCT FROM 'null'::jsonb
  OR p_body->'executionAuthorityGranted' IS DISTINCT FROM 'false'::jsonb
  OR p_body->'ref'->>'owner' IS DISTINCT FROM 'S5'
  OR p_body->'ref'->>'version' IS DISTINCT FROM 'application-operation-v1'
  OR coalesce(p_body->'ref'->>'contentDigest','') !~ '^[a-f0-9]{64}$'
  OR p_body->'ref'->>'id' IS DISTINCT FROM 'application-consumption:'||(p_body->'ref'->>'contentDigest')
  OR length(coalesce(p_body->>'idempotencyKey','')) NOT BETWEEN 1 AND 256
  OR length(coalesce(p_body->>'nodeId','')) NOT BETWEEN 1 AND 512
  OR coalesce(p_body->>'requestDigest','') !~ '^[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'Z0 original application consumption invalid'; END IF;
 IF p_body->>'nodeId'='original-computation' THEN
  IF p_body->'operationRef' IS DISTINCT FROM cert->'preparationRef'
   OR p_body->'preparationRef' IS DISTINCT FROM cert->'preparationRef'
   OR p_body->'predecessorObservationRef' IS DISTINCT FROM cert->'preparationRef'
   OR p_body->>'requestDigest' IS DISTINCT FROM cert->>'requestDigest'
   THEN RAISE EXCEPTION 'Z0 original computation binding changed'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM finnor_os.application_semantics_sessions s
    WHERE s.tenant_id=t AND s.principal_id=u AND s.id=s.parent_id
      AND s.allocation_ref=p_body->'certificateRef' AND s.reservation_ref=parent->'ref'
      AND s.original_parent_ref=cert->'originalParentRef'
      AND p_body->>'nodeId' LIKE s.id::text||':%'
      AND s.cancel_requested_at IS NULL AND s.deadline_at>clock_timestamp()
      AND s.status NOT IN('COMPLETED','MODEL_READY','CANCELLED','FAILED','STALE','BLOCKED'))
    THEN RAISE EXCEPTION 'Z0 actual original application session required'; END IF;
 END IF;
 SELECT body INTO prior FROM finnor_os.s5_consumptions
  WHERE tenant_id=t AND principal_id=u AND idempotency_key=p_body->>'idempotencyKey';
 IF FOUND THEN
  IF prior IS DISTINCT FROM p_body THEN RAISE EXCEPTION 'Z0 consumption replay conflict'; END IF;
  RETURN prior;
 END IF;
 IF (SELECT count(*) FROM finnor_os.s5_consumptions WHERE tenant_id=t
    AND reservation_id=parent->'ref'->>'id')>=1420 THEN RAISE EXCEPTION 'Z0 original consumption bound exhausted'; END IF;
 INSERT INTO finnor_os.s5_consumptions(tenant_id,principal_id,consumption_id,reservation_id,
  policy_id,node_id,idempotency_key,request_digest,body)
 VALUES(t,u,p_body->'ref'->>'id',parent->'ref'->>'id',p_body->'preparationRef'->>'id',
  p_body->>'nodeId',p_body->>'idempotencyKey',p_body->>'requestDigest',p_body);
 INSERT INTO finnor_os.s5_consumption_states(tenant_id,consumption_id,status,revision)
 VALUES(t,p_body->'ref'->>'id','INTENDED_PENDING_S6',1);
 UPDATE finnor_os.s5_reservations SET status='CONSUMPTION_PENDING',revision=revision+1
  WHERE tenant_id=t AND reservation_id=parent->'ref'->>'id' AND status='RESERVED';
 RETURN p_body;
END $$;
REVOKE ALL ON FUNCTION finnor_os.z0_s5_application_consumption(jsonb,uuid) FROM PUBLIC;

CREATE FUNCTION finnor_os.z0_s5_application_charge(p_body jsonb,p_decision uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id(); u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
 frame jsonb; cert jsonb; parent jsonb; prior jsonb; co jsonb; original_limit numeric; child_limit numeric;
 original_used numeric; child_used numeric; recovery boolean;
BEGIN
 recovery:=coalesce((p_body->>'recovery')::boolean,false);
 frame:=finnor_os.z0_s5_application_frame(p_body->'allocationRef',p_decision,recovery);
 cert:=frame->'certificate'; parent:=frame->'parent';
 SELECT body INTO co FROM finnor_os.s5_consumptions WHERE tenant_id=t AND principal_id=u
  AND consumption_id=p_body->'consumptionRef'->>'id' AND reservation_id=parent->'ref'->>'id';
 IF co IS NULL OR co->'ref' IS DISTINCT FROM p_body->'consumptionRef'
  OR co->'certificateRef' IS DISTINCT FROM p_body->'allocationRef'
  OR p_body->'reservationRef' IS DISTINCT FROM parent->'ref'
  OR p_body->'originalParentRef' IS DISTINCT FROM cert->'originalParentRef'
  OR p_body->>'tenantId' IS DISTINCT FROM t::text OR p_body->>'principalId' IS DISTINCT FROM u::text
  OR p_body->>'schema' IS DISTINCT FROM 'finnor.s5.application-resource-charge.v1'
  OR p_body->'executionAuthorityGranted' IS DISTINCT FROM 'false'::jsonb
  OR coalesce(p_body->>'phase','') NOT IN('ACQUISITION','CHECKING','COMPOSITION','EXECUTION','RECOVERY','OBSERVATION','MAINTENANCE','HUMAN')
  OR p_body->>'unit' IS DISTINCT FROM (CASE WHEN p_body->>'phase'='HUMAN' THEN 'seconds' ELSE 'request' END)
  OR (recovery AND p_body->>'phase'<>'RECOVERY')
  OR coalesce(p_body->>'units','') !~ '^[1-9][0-9]{0,3}$' OR (p_body->>'units')::integer>2048
  OR coalesce(p_body->'ref'->>'contentDigest','') !~ '^[a-f0-9]{64}$'
  OR coalesce(p_body->>'requestDigest','') !~ '^[a-f0-9]{64}$'
  OR length(coalesce(p_body->>'chargeKey','')) NOT BETWEEN 1 AND 512
  OR p_body->'ref'->>'id' IS DISTINCT FROM 'application-resource-charge:'||(p_body->'ref'->>'contentDigest')
  OR p_body->'ref'->>'owner' IS DISTINCT FROM 'S5'
  OR p_body->'ref'->>'version' IS DISTINCT FROM 'application-operation-v1'
  THEN RAISE EXCEPTION 'Z0 exact original application charge invalid'; END IF;
 IF recovery AND NOT EXISTS(SELECT 1 FROM finnor_os.application_semantics_requests r
   JOIN finnor_os.application_semantics_sessions s ON s.tenant_id=r.tenant_id AND s.id=r.session_id
   WHERE r.tenant_id=t AND r.principal_id=u AND s.allocation_ref=p_body->'allocationRef'
    AND r.possible_egress AND r.status NOT IN('VERIFIED','DENIED'))
   THEN RAISE EXCEPTION 'Z0 recovery cannot renew forward spending'; END IF;
 SELECT body INTO prior FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=t
  AND reservation_id=parent->'ref'->>'id' AND charge_key=p_body->>'chargeKey';
 IF FOUND THEN
  IF prior IS DISTINCT FROM p_body THEN RAISE EXCEPTION 'Z0 original charge replay conflict'; END IF;
  RETURN prior;
 END IF;
 SELECT sum(q.value::numeric) INTO original_limit FROM jsonb_array_elements(parent->'envelopes') e
  CROSS JOIN LATERAL jsonb_array_elements_text(e->'quantities') q(value)
  WHERE e->>'resourceId'=p_body->>'resourceId' AND e->>'unit'=p_body->>'unit';
 SELECT sum(q.value::numeric) INTO child_limit FROM jsonb_array_elements(cert->'check'->'envelopes') e
  CROSS JOIN LATERAL jsonb_array_elements_text(e->'quantities') q(value)
  WHERE e->>'resourceId'=p_body->>'resourceId' AND e->>'unit'=p_body->>'unit';
 SELECT coalesce(sum(units),0),coalesce(sum(units) FILTER(WHERE body->'allocationRef'=p_body->'allocationRef'),0)
  INTO original_used,child_used FROM finnor_os.s5_governed_resource_charges
  WHERE tenant_id=t AND reservation_id=parent->'ref'->>'id' AND resource_id=p_body->>'resourceId';
 IF original_limit IS NULL OR child_limit IS NULL OR original_used+(p_body->>'units')::integer>original_limit
  OR child_used+(p_body->>'units')::integer>child_limit
  OR p_body->>'limit' IS DISTINCT FROM original_limit::text
  OR p_body->>'childLimit' IS DISTINCT FROM child_limit::text
  OR p_body->>'usedAfter' IS DISTINCT FROM (original_used+(p_body->>'units')::integer)::text
  OR p_body->>'childUsedAfter' IS DISTINCT FROM (child_used+(p_body->>'units')::integer)::text
  OR (SELECT count(*) FROM finnor_os.s5_governed_resource_charges
    WHERE tenant_id=t AND reservation_id=parent->'ref'->>'id')>=1420
  THEN RAISE EXCEPTION 'Z0 original resource envelope exhausted'; END IF;
 INSERT INTO finnor_os.s5_governed_resource_charges(tenant_id,principal_id,reservation_id,consumption_id,
  charge_key,phase,resource_id,unit,units,request_digest,body)
 VALUES(t,u,parent->'ref'->>'id',co->'ref'->>'id',p_body->>'chargeKey',p_body->>'phase',
  p_body->>'resourceId',p_body->>'unit',(p_body->>'units')::integer,p_body->>'requestDigest',p_body);
 RETURN p_body;
END $$;
REVOKE ALL ON FUNCTION finnor_os.z0_s5_application_charge(jsonb,uuid) FROM PUBLIC;

CREATE FUNCTION finnor_os.z0_s5_application_effect_state(p_obligation text,p_stage text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id(); u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
 obligation jsonb; co jsonb; frame jsonb; effect_id uuid; effect_hash text; effect_status text;
 request_status text; possible boolean; revision integer;
BEGIN
 SELECT o.body,o.effect_id,e.semantic_hash,e.status,c.body INTO obligation,effect_id,effect_hash,effect_status,co
  FROM finnor_os.s6_obligation_origins o JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id
  JOIN finnor_os.s5_consumptions c ON c.tenant_id=o.tenant_id AND c.consumption_id=o.consumption_id
  WHERE o.tenant_id=t AND o.principal_id=u AND o.obligation_id=p_obligation;
 IF co IS NULL OR obligation->>'schema' IS DISTINCT FROM 'finnor.s6.application-obligation.v1'
  OR co->'ref' IS DISTINCT FROM obligation->'consumptionRef'
  OR co->'certificateRef' IS DISTINCT FROM obligation->'allocationRef'
  THEN RAISE EXCEPTION 'Z0 canonical application obligation unavailable'; END IF;
 frame:=finnor_os.z0_s5_application_frame(co->'certificateRef',NULL,true);
 IF coalesce(p_stage,'') NOT IN('BOUND','POSSIBLE','OBSERVED') THEN RAISE EXCEPTION 'Z0 S6 observation stage invalid'; END IF;
 SELECT r.status,r.possible_egress INTO request_status,possible FROM finnor_os.application_semantics_requests r
  WHERE r.tenant_id=t AND r.principal_id=u AND r.obligation_id=p_obligation;
 IF p_stage='POSSIBLE' AND (possible IS DISTINCT FROM true OR effect_status<>'executing')
  OR p_stage='OBSERVED' AND (request_status IS NULL
    OR request_status='VERIFIED' AND effect_status<>'verified'
    OR request_status='DENIED' AND effect_status<>'cancelled')
  THEN RAISE EXCEPTION 'Z0 actual S6 state observation required'; END IF;
 UPDATE finnor_os.s5_consumption_states SET
  effect_ref=jsonb_build_object('owner','S6','id',effect_id,'version','business-effect-v1','contentDigest',effect_hash),
  status=CASE WHEN p_stage='BOUND' THEN status
    WHEN p_stage='OBSERVED' AND request_status IN('VERIFIED','DENIED') THEN 'RECONCILED' ELSE 'UNKNOWN_OUTCOME' END,
  revision=s5_consumption_states.revision+1,updated_at=clock_timestamp()
  WHERE tenant_id=t AND consumption_id=co->'ref'->>'id' RETURNING s5_consumption_states.revision INTO revision;
 IF p_stage='POSSIBLE' OR p_stage='OBSERVED' AND request_status NOT IN('VERIFIED','DENIED') THEN
  UPDATE finnor_os.s5_reservations SET status='UNKNOWN_OUTCOME',revision=s5_reservations.revision+1
   WHERE tenant_id=t AND reservation_id=frame->'parent'->'ref'->>'id' AND status<>'UNKNOWN_OUTCOME';
 END IF;
 -- Never downgrade or release the parent: other X1/S6 consumption may still be unknown.
 RETURN jsonb_build_object('revision',revision,'originalReservationRef',frame->'parent'->'ref','releaseGranted',false);
END $$;
REVOKE ALL ON FUNCTION finnor_os.z0_s5_application_effect_state(text,text) FROM PUBLIC;

-- An application-shaped child of a private institution is still private.
CREATE POLICY z0_inherited_application_consumption_privacy ON finnor_os.s5_consumptions AS RESTRICTIVE
 FOR SELECT USING(body->>'schema'<>'finnor.s5.application-consumption.v1'
   OR reservation_id NOT LIKE 'institution-reservation:%' OR finnor_os.s5_institution_visible(reservation_id));
CREATE POLICY z0_inherited_application_charge_privacy ON finnor_os.s5_governed_resource_charges AS RESTRICTIVE
 FOR SELECT USING(body->>'schema'<>'finnor.s5.application-resource-charge.v1'
   OR reservation_id NOT LIKE 'institution-reservation:%' OR finnor_os.s5_institution_visible(reservation_id));
CREATE POLICY z0_inherited_application_history_privacy ON finnor_os.s5_history AS RESTRICTIVE
 FOR SELECT USING(operation<>'APPLICATION_S6_OBSERVATION' OR finnor_os.s5_institution_consumption_visible(subject_id));

-- Execution of this integration input is not authorized by its presence.
-- The coordinator's normal migration process owns these narrowly scoped grants.
GRANT EXECUTE ON FUNCTION finnor_os.z0_s5_application_consumption(jsonb,uuid),
 finnor_os.z0_s5_application_charge(jsonb,uuid),finnor_os.z0_s5_application_effect_state(text,text)
 TO finnor_app,finnor_worker;
