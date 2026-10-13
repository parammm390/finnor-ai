-- Add physical request-unit identities to the existing original S5 serializer.
-- Original resources, deadlines, rights/currentness, occupancy and old charge
-- hashes are unchanged. No execution/admission/funding authority is granted.
ALTER TABLE finnor_os.s5_governed_resource_charges
 DROP CONSTRAINT s5_governed_resource_charges_phase_check;
ALTER TABLE finnor_os.s5_governed_resource_charges
 ADD CONSTRAINT s5_governed_resource_charges_phase_check CHECK(
  phase IN('EXECUTION','RECOVERY','HUMAN') OR
  (body->>'schema' IS NOT DISTINCT FROM 'finnor.s5.institution-consumption.v1'
   AND phase IN('ACQUISITION','CHECK','COMPILE','PREPARATION','CONTROL','LIFECYCLE')));

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
  IF (p_body->>'phase' IN('PREPARATION','CONTROL','LIFECYCLE')) IS DISTINCT FROM (p_body ? 'physicalInvocationId')
    OR (p_body->>'phase' IN('PREPARATION','CONTROL','LIFECYCLE') AND
      (v_origin->'demand'->'chargeScope'->>'kind' IS DISTINCT FROM 'ORIGINAL_WORK_EPISODE'
       OR (p_body->>'ordinal')::integer IS DISTINCT FROM 1
       OR p_body->>'physicalInvocationId' IS NULL
       OR p_body->>'physicalInvocationId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
  THEN RAISE EXCEPTION 'S5 actual physical institution charge identity required'; END IF;
  IF p_body->>'chargeKey'<>('x1-charge:'||encode(sha256(convert_to(replace(
      (CASE WHEN p_body->>'phase' IN('PREPARATION','CONTROL','LIFECYCLE') THEN
      jsonb_build_array(v_origin->'demand'->>'demandDigest',p_body->>'responsibilityIdentity',
        p_body->>'phase',p_body->>'physicalInvocationId') ELSE jsonb_build_array(v_origin->'demand'->>'demandDigest',p_body->>'responsibilityIdentity',
        p_body->>'phase',(p_body->>'ordinal')::integer) END)::text,', ',','),'UTF8')),'hex'))
    OR p_body->>'requestDigest'<>encode(sha256(convert_to(replace(
      (CASE WHEN p_body->>'phase' IN('PREPARATION','CONTROL','LIFECYCLE') THEN
      jsonb_build_array('institution-charge-request-v1',v_origin->'demand'->>'demandDigest',
        p_body->>'responsibilityIdentity',p_body->>'phase',p_body->>'physicalInvocationId',
        (p_body->>'units')::integer) ELSE jsonb_build_array('institution-charge-request-v1',v_origin->'demand'->>'demandDigest',
        p_body->>'responsibilityIdentity',p_body->>'phase',
        (p_body->>'ordinal')::integer,(p_body->>'units')::integer) END)::text,', ',','),'UTF8')),'hex')
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
    OR (p_body->>'phase') NOT IN ('EXECUTION','RECOVERY','HUMAN','ACQUISITION','CHECK','COMPILE','PREPARATION','CONTROL','LIFECYCLE')
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
