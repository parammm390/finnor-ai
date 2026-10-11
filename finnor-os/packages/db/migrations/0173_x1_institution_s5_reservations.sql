-- Add a typed institution branch to the existing S5 proposal, reservation,
-- consumption and unit-charge lifecycle. No finite policy/certificate is
-- manufactured: native finite rows keep their exact original grammar.
ALTER TABLE finnor_os.s5_proposals
  ALTER COLUMN problem DROP NOT NULL, ALTER COLUMN certificate DROP NOT NULL;
ALTER TABLE finnor_os.s5_proposals ADD COLUMN demand jsonb;
ALTER TABLE finnor_os.s5_proposals ADD CONSTRAINT s5_proposal_domain CHECK (
  (problem IS NOT NULL AND certificate IS NOT NULL AND demand IS NULL)
  OR (problem IS NULL AND certificate IS NULL AND demand IS NOT NULL
    AND demand->>'schema'='finnor.x1.institution-resource-demand.v1'
    AND octet_length(demand::text)<=262144));

-- The existing projection's allocation_digest FK now addresses either a
-- finite certificate digest or an institution demand digest.
CREATE FUNCTION finnor_os.s5_institution_owner_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE v_institution boolean;
BEGIN
  IF TG_TABLE_NAME='s5_proposals' THEN
    v_institution := (CASE WHEN TG_OP='DELETE' THEN OLD.demand ELSE NEW.demand END) IS NOT NULL;
  ELSIF TG_TABLE_NAME='s5_reservation_origins' THEN
    SELECT p.demand IS NOT NULL INTO v_institution FROM finnor_os.s5_proposals p
      WHERE p.tenant_id=(CASE WHEN TG_OP='INSERT' THEN NEW.tenant_id ELSE OLD.tenant_id END)
        AND p.content_digest=(CASE WHEN TG_OP='INSERT' THEN NEW.allocation_digest ELSE OLD.allocation_digest END);
  ELSIF TG_TABLE_NAME='s5_reservations' THEN
    SELECT o.body->>'schema'='finnor.s5.institution-reservation.v1'
      INTO v_institution FROM finnor_os.s5_reservation_origins o
      WHERE o.tenant_id=(CASE WHEN TG_OP='INSERT' THEN NEW.tenant_id ELSE OLD.tenant_id END)
        AND o.reservation_id=(CASE WHEN TG_OP='INSERT' THEN NEW.reservation_id ELSE OLD.reservation_id END);
  ELSIF TG_TABLE_NAME='s5_consumptions' THEN
    SELECT o.body->>'schema'='finnor.s5.institution-reservation.v1'
      INTO v_institution FROM finnor_os.s5_reservation_origins o
      WHERE o.tenant_id=(CASE WHEN TG_OP='INSERT' THEN NEW.tenant_id ELSE OLD.tenant_id END)
        AND o.reservation_id=(CASE WHEN TG_OP='INSERT' THEN NEW.reservation_id ELSE OLD.reservation_id END);
  ELSE
    SELECT o.body->>'schema'='finnor.s5.institution-reservation.v1'
      INTO v_institution FROM finnor_os.s5_reservation_origins o
      WHERE o.tenant_id=(CASE WHEN TG_OP='INSERT' THEN NEW.tenant_id ELSE OLD.tenant_id END)
        AND o.reservation_id=(CASE WHEN TG_OP='INSERT' THEN NEW.reservation_id ELSE OLD.reservation_id END);
  END IF;
  IF v_institution AND current_user<>pg_get_userbyid(
    (SELECT relowner FROM pg_class WHERE oid='finnor_os.s5_reservations'::regclass))
  THEN RAISE EXCEPTION 'S5 institution lifecycle requires owner writer'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['s5_proposals','s5_reservation_origins','s5_reservations',
    's5_consumptions','s5_governed_resource_charges'] LOOP
    EXECUTE format('CREATE TRIGGER s5_institution_owner_guard BEFORE INSERT OR UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.s5_institution_owner_guard()',t);
  END LOOP;
END $$;
CREATE FUNCTION finnor_os.s5_institution_state_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM finnor_os.s5_consumptions c
    JOIN finnor_os.s5_reservation_origins o USING(tenant_id,reservation_id)
    WHERE c.tenant_id=(CASE WHEN TG_OP='INSERT' THEN NEW.tenant_id ELSE OLD.tenant_id END)
      AND c.consumption_id=(CASE WHEN TG_OP='INSERT' THEN NEW.consumption_id ELSE OLD.consumption_id END)
      AND o.body->>'schema'='finnor.s5.institution-reservation.v1')
    AND current_user<>pg_get_userbyid(
      (SELECT relowner FROM pg_class WHERE oid='finnor_os.s5_reservations'::regclass))
  THEN RAISE EXCEPTION 'S5 institution consumption state requires owner writer'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER s5_institution_state_guard BEFORE INSERT OR UPDATE OR DELETE
  ON finnor_os.s5_consumption_states FOR EACH ROW
  EXECUTE FUNCTION finnor_os.s5_institution_state_guard();

-- Restrict direct institution-body reads without changing finite S5 readers.
CREATE FUNCTION finnor_os.s5_institution_visible(p_reservation_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE v_tenant uuid:=finnor_os.request_tenant_id();
  v_user uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
  RETURN EXISTS(SELECT 1 FROM finnor_os.s5_reservation_origins o
    WHERE o.tenant_id=v_tenant AND o.reservation_id=p_reservation_id
      AND (o.body->>'schema'<>'finnor.s5.institution-reservation.v1'
        OR o.principal_id=v_user));
END $$;
CREATE FUNCTION finnor_os.s5_institution_consumption_visible(p_consumption_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE v_tenant uuid:=finnor_os.request_tenant_id();
  v_user uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
  RETURN EXISTS(SELECT 1 FROM finnor_os.s5_consumptions c
    JOIN finnor_os.s5_reservation_origins o USING(tenant_id,reservation_id)
    WHERE c.tenant_id=v_tenant AND c.consumption_id=p_consumption_id
      AND (o.body->>'schema'<>'finnor.s5.institution-reservation.v1'
        OR o.principal_id=v_user));
END $$;
CREATE POLICY s5_institution_proposal_privacy ON finnor_os.s5_proposals AS RESTRICTIVE
  FOR SELECT USING (demand IS NULL OR current_user<>'finnor_app'
    OR principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY s5_institution_origin_privacy ON finnor_os.s5_reservation_origins AS RESTRICTIVE
  FOR SELECT USING (current_user<>'finnor_app'
    OR body->>'schema'<>'finnor.s5.institution-reservation.v1'
    OR principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY s5_institution_reservation_privacy ON finnor_os.s5_reservations AS RESTRICTIVE
  FOR SELECT USING (current_user<>'finnor_app'
    OR finnor_os.s5_institution_visible(reservation_id));
CREATE POLICY s5_institution_consumption_privacy ON finnor_os.s5_consumptions AS RESTRICTIVE
  FOR SELECT USING (body->>'schema'<>'finnor.s5.institution-consumption.v1'
    OR current_user<>'finnor_app' OR principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY s5_institution_charge_privacy ON finnor_os.s5_governed_resource_charges AS RESTRICTIVE
  FOR SELECT USING (body->>'schema'<>'finnor.s5.institution-consumption.v1'
    OR current_user<>'finnor_app' OR principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY s5_institution_state_privacy ON finnor_os.s5_consumption_states AS RESTRICTIVE
  FOR SELECT USING (current_user<>'finnor_app'
    OR finnor_os.s5_institution_consumption_visible(consumption_id));
CREATE POLICY s5_institution_history_privacy ON finnor_os.s5_history AS RESTRICTIVE
  FOR SELECT USING (current_user<>'finnor_app'
    OR (operation<>'s5_reservations' OR finnor_os.s5_institution_visible(subject_id))
      AND (operation<>'s5_consumption_states'
        OR finnor_os.s5_institution_consumption_visible(subject_id)));

-- Tenant-wide occupancy is an aggregate only; it never discloses another
-- principal's reservation, Work, demand or charge body.
CREATE FUNCTION finnor_os.s5_institution_occupancy(p_resource_id text)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,finnor_os AS $$
DECLARE v_tenant uuid:=finnor_os.request_tenant_id(); v_total numeric;
BEGIN
  IF v_tenant IS NULL OR nullif(current_setting('app.user_id',true),'') IS NULL THEN
    RAISE EXCEPTION 'S5 authenticated occupancy context required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM finnor_os.users
    WHERE tenant_id=v_tenant AND id=current_setting('app.user_id')::uuid
      AND role='owner' AND status='active') THEN
    RAISE EXCEPTION 'S5 owner occupancy authority required';
  END IF;
  SELECT COALESCE(sum((e->'quantities'->>0)::numeric),0) INTO v_total
    FROM finnor_os.s5_reservations s
    JOIN finnor_os.s5_proposals p ON p.tenant_id=s.tenant_id
      AND p.content_digest=s.allocation_digest AND p.demand IS NOT NULL
    CROSS JOIN LATERAL jsonb_array_elements(s.envelopes) AS e
   WHERE s.tenant_id=v_tenant AND s.status<>'RELEASED'
     AND e->>'resourceId'=p_resource_id;
  RETURN v_total;
END $$;

CREATE FUNCTION finnor_os.s5_reserve_institution(
  p_demand jsonb, p_origin jsonb, p_envelopes jsonb, p_request_digest text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,finnor_os AS $$
DECLARE v_tenant uuid:=finnor_os.request_tenant_id();
  v_user uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  v_digest text:=p_demand->>'demandDigest'; v_id text:=p_origin->'ref'->>'id';
  v_prior record; v_line jsonb; v_resource jsonb; v_envelope jsonb;
  v_occupied numeric; v_capacity numeric; v_period integer; v_available jsonb; v_matches integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('s5-portfolio:'||v_tenant::text,0));
  IF v_tenant IS NULL OR v_user IS NULL OR p_demand->>'tenantId'<>v_tenant::text
    OR p_demand->>'principalId' IS DISTINCT FROM v_user::text
    OR p_origin->>'tenantId' IS DISTINCT FROM v_tenant::text
    OR p_origin->>'principalId' IS DISTINCT FROM v_user::text
    OR p_origin->>'schema' IS DISTINCT FROM 'finnor.s5.institution-reservation.v1'
    OR p_origin->'demand' IS DISTINCT FROM p_demand
    OR p_origin->'envelopes' IS DISTINCT FROM p_envelopes
    OR p_origin->'demandRef'->>'id' IS NULL
    OR v_id IS NULL OR v_digest !~ '^[a-f0-9]{64}$'
    OR p_request_digest !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p_envelopes)<>'array' OR jsonb_array_length(p_envelopes)=0
    OR p_demand->>'qualification' IS DISTINCT FROM 'DECLARED_ACCOUNTING_NOT_FUNDING'
    OR p_demand->>'originalDeadline' IS DISTINCT FROM p_origin->>'originalDeadline'
    OR p_origin->>'rightsRevision' IS DISTINCT FROM (
      SELECT revision::text FROM finnor_os.authority_states WHERE tenant_id=v_tenant)
    OR p_demand->>'workId' IS DISTINCT FROM p_origin->>'workId'
    OR p_demand->>'originalDeadline' IS NULL
    OR p_demand->'lines' IS NULL
    OR jsonb_typeof(p_demand->'lines') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_demand->'lines')<>2
    OR (SELECT count(DISTINCT line->>'resourceClass')
      FROM jsonb_array_elements(p_demand->'lines') line)<>2
    OR jsonb_typeof(p_origin->'resources') IS DISTINCT FROM 'array'
    OR p_origin->'resources' IS DISTINCT FROM (
      SELECT coalesce(jsonb_agg(r.body->'ref' ORDER BY r.resource_id),'[]'::jsonb)
      FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h
        USING(tenant_id,resource_id,revision) WHERE r.tenant_id=v_tenant)
    OR (p_demand->>'originalDeadline')::timestamptz<=clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM finnor_os.users WHERE tenant_id=v_tenant AND id=v_user AND role='owner' AND status='active')
    OR NOT EXISTS(SELECT 1 FROM finnor_os.works WHERE tenant_id=v_tenant
      AND id=(p_demand->>'workId')::uuid AND created_by=v_user)
    OR NOT EXISTS(SELECT 1 FROM finnor_os.x1_work_mandates m
      WHERE m.tenant_id=v_tenant AND m.work_id=(p_demand->>'workId')::uuid
        AND m.principal_id=v_user AND m.institution_id=p_demand->>'institutionId'
        AND m.revoked_at IS NULL AND m.valid_from<=clock_timestamp() AND m.expires_at>clock_timestamp()
        AND (SELECT min(rule->>'deadlineAt') FROM jsonb_array_elements(m.rules) rule)
          =p_demand->>'originalDeadline')
  THEN RAISE EXCEPTION 'S5 institution original demand or owner context invalid'; END IF;
  SELECT o.body,s.status,p.demand AS stored_demand INTO v_prior
    FROM finnor_os.s5_reservation_origins o
    JOIN finnor_os.s5_reservations s USING(tenant_id,reservation_id)
    JOIN finnor_os.s5_proposals p ON p.tenant_id=o.tenant_id AND p.content_digest=o.allocation_digest
    WHERE o.tenant_id=v_tenant AND o.reservation_id=v_id;
  IF FOUND THEN
    IF v_prior.body<>p_origin OR v_prior.stored_demand<>p_demand OR v_prior.status='RELEASED'
      THEN RAISE EXCEPTION 'S5 institution replay conflict'; END IF;
    RETURN v_prior.body||jsonb_build_object('status',v_prior.status);
  END IF;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_demand->'lines') LOOP
    IF v_line->>'quantity' !~ '^(0|[1-9][0-9]*)$'
      OR v_line->>'resourceClass' NOT IN ('COMPUTE','HUMAN_ATTENTION')
      OR (v_line->>'resourceClass'='COMPUTE' AND v_line->>'unit'<>'request')
      OR (v_line->>'resourceClass'='HUMAN_ATTENTION' AND v_line->>'unit'<>'seconds')
      THEN RAISE EXCEPTION 'S5 institution demand line invalid'; END IF;
    IF (v_line->>'quantity')::numeric=0 THEN CONTINUE; END IF;
    SELECT r.body INTO v_resource FROM finnor_os.s5_resources r
      JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision)
      WHERE r.tenant_id=v_tenant AND r.body->>'resourceClass'=v_line->>'resourceClass'
        AND r.body->>'unit'=v_line->>'unit' AND r.body->>'kind'='CUMULATIVE_EXPENDITURE';
    SELECT count(*) INTO v_matches FROM finnor_os.s5_resources r
      JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision)
      WHERE r.tenant_id=v_tenant AND r.body->>'resourceClass'=v_line->>'resourceClass'
        AND r.body->>'unit'=v_line->>'unit' AND r.body->>'kind'='CUMULATIVE_EXPENDITURE';
    IF v_matches<>1 THEN RAISE EXCEPTION 'S5 institution resource missing or ambiguous'; END IF;
    SELECT value INTO v_envelope FROM jsonb_array_elements(p_envelopes)
      WHERE value->>'resourceId'=v_resource->>'resourceId';
    IF v_envelope IS NULL OR v_envelope->'quantities'->>0<>v_line->>'quantity'
      OR v_envelope->>'unit' IS DISTINCT FROM v_resource->>'unit'
      OR v_envelope->>'kind' IS DISTINCT FROM 'CUMULATIVE_EXPENDITURE'
      OR v_envelope->'horizon' IS DISTINCT FROM v_resource->'horizon'
      OR v_envelope->'minimumQuantities' IS DISTINCT FROM v_envelope->'quantities'
      OR jsonb_array_length(v_envelope->'quantities')<>jsonb_array_length(v_resource->'availability')
      OR v_resource->'currency'<>'null'::jsonb
      OR v_resource->'covenants'<>'[]'::jsonb
      OR v_resource->>'validUntil' IS NULL OR (v_resource->>'validUntil')::timestamptz<=clock_timestamp()
      OR (v_resource->>'revoked')::boolean
      THEN RAISE EXCEPTION 'S5 institution resource envelope changed'; END IF;
    FOR v_period IN 0..jsonb_array_length(v_resource->'availability')-1 LOOP
      v_available:=v_resource->'availability'->v_period;
      IF v_available->>'basis' IS DISTINCT FROM 'REPORTED_AVAILABLE'
        OR v_available->>'amount' IS NULL
        OR (v_period>0 AND v_envelope->'quantities'->>v_period<>'0')
        THEN RAISE EXCEPTION 'S5 institution resource horizon invalid'; END IF;
      SELECT COALESCE(sum((part.value)::numeric),0) INTO v_occupied
        FROM finnor_os.s5_reservations s
        CROSS JOIN LATERAL jsonb_array_elements(s.envelopes) e
        CROSS JOIN LATERAL jsonb_array_elements_text(e->'quantities') WITH ORDINALITY part(value,period)
        WHERE s.tenant_id=v_tenant AND s.status<>'RELEASED'
          AND e->>'resourceId'=v_resource->>'resourceId' AND part.period<=v_period+1;
      v_capacity:=(v_available->>'amount')::numeric
        -(v_resource->>'safetyMargin')::numeric
        -(SELECT COALESCE(sum(value::numeric),0)
          FROM jsonb_array_elements_text(v_resource->'existingUse') WITH ORDINALITY u(value,period)
          WHERE u.period<=v_period+1);
      IF v_occupied+(v_line->>'quantity')::numeric>v_capacity
        THEN RAISE EXCEPTION 'S5 shared resource capacity exhausted'; END IF;
    END LOOP;
  END LOOP;
  IF jsonb_array_length(p_envelopes)<>(
    SELECT count(*) FROM jsonb_array_elements(p_demand->'lines') line WHERE (line->>'quantity')::numeric>0)
  THEN RAISE EXCEPTION 'S5 institution resource occupation incomplete'; END IF;
  INSERT INTO finnor_os.s5_proposals(tenant_id,principal_id,content_digest,demand)
    VALUES(v_tenant,v_user,v_digest,p_demand);
  INSERT INTO finnor_os.s5_reservation_origins(tenant_id,principal_id,reservation_id,allocation_digest,body)
    VALUES(v_tenant,v_user,v_id,v_digest,p_origin);
  INSERT INTO finnor_os.s5_reservations(tenant_id,reservation_id,allocation_digest,revision,status,envelopes)
    VALUES(v_tenant,v_id,v_digest,1,'RESERVED',p_envelopes);
  RETURN p_origin;
END $$;

CREATE FUNCTION finnor_os.s5_consume_institution(p_reservation_id text,p_body jsonb)
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
  IF v_origin IS NULL OR v_status='RELEASED' OR p_body->>'schema'<>'finnor.s5.institution-consumption.v1'
    OR p_body->'reservationRef'<>v_origin->'ref'
    OR p_body->>'originalDeadline'<>v_origin->>'originalDeadline'
    OR p_body->>'parentWorkId'<>v_origin->>'workId'
    OR p_body->'ref'->>'owner'<>'S5'
    OR p_body->'ref'->>'id' IS NULL
    OR (v_origin->>'originalDeadline')::timestamptz<=clock_timestamp()
    OR v_origin->>'rightsRevision' IS DISTINCT FROM (
      SELECT revision::text FROM finnor_os.authority_states WHERE tenant_id=v_tenant)
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
    OR NOT (v_origin->'demand'->'responsibilityIdentities' ? (p_body->>'responsibilityIdentity'))
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
    WHERE tenant_id=v_tenant AND reservation_id=p_reservation_id)>=512
    THEN RAISE EXCEPTION 'S5 institution original charge bound exhausted'; END IF;
  SELECT COALESCE(sum(units),0) INTO v_used FROM finnor_os.s5_governed_resource_charges
    WHERE tenant_id=v_tenant AND reservation_id=p_reservation_id AND resource_id=p_body->>'resourceId';
  SELECT max((e->'quantities'->>0)::numeric) INTO v_limit
    FROM jsonb_array_elements(v_origin->'envelopes') e
    WHERE e->>'resourceId'=p_body->>'resourceId' AND e->>'unit'=p_body->>'unit';
  IF v_limit IS NULL OR (p_body->>'units')::integer NOT BETWEEN 1 AND 100000
    OR (p_body->>'phase') NOT IN ('EXECUTION','RECOVERY','HUMAN')
    OR (p_body->>'ordinal')::integer NOT BETWEEN 1 AND 64
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

CREATE FUNCTION finnor_os.s5_release_untouched_institution(p_reservation_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE v_tenant uuid:=finnor_os.request_tenant_id();
  v_user uuid:=nullif(current_setting('app.user_id',true),'')::uuid; v_origin jsonb; v_status text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('s5-portfolio:'||v_tenant::text,0));
  SELECT o.body,s.status INTO v_origin,v_status FROM finnor_os.s5_reservation_origins o
    JOIN finnor_os.s5_reservations s USING(tenant_id,reservation_id)
    WHERE o.tenant_id=v_tenant AND o.principal_id=v_user AND o.reservation_id=p_reservation_id
      AND o.body->>'schema'='finnor.s5.institution-reservation.v1' FOR UPDATE OF s;
  IF v_origin IS NULL OR EXISTS(SELECT 1 FROM finnor_os.s5_consumptions
    WHERE tenant_id=v_tenant AND reservation_id=p_reservation_id)
    OR v_status IN ('CONSUMPTION_PENDING','UNKNOWN_OUTCOME')
  THEN RAISE EXCEPTION 'S5 institution possible liability retains occupation'; END IF;
  IF v_status<>'RELEASED' THEN
    UPDATE finnor_os.s5_reservations SET status='RELEASED',revision=revision+1
      WHERE tenant_id=v_tenant AND reservation_id=p_reservation_id;
  END IF;
  RETURN v_origin||'{"status":"RELEASED"}'::jsonb;
END $$;

REVOKE ALL ON FUNCTION finnor_os.s5_institution_occupancy(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.s5_institution_visible(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.s5_institution_consumption_visible(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.s5_reserve_institution(jsonb,jsonb,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.s5_consume_institution(text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.s5_release_untouched_institution(text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
  GRANT EXECUTE ON FUNCTION finnor_os.s5_institution_occupancy(text) TO finnor_app;
  GRANT EXECUTE ON FUNCTION finnor_os.s5_institution_visible(text) TO finnor_app;
  GRANT EXECUTE ON FUNCTION finnor_os.s5_institution_consumption_visible(text) TO finnor_app;
  GRANT EXECUTE ON FUNCTION finnor_os.s5_reserve_institution(jsonb,jsonb,jsonb,text) TO finnor_app;
  GRANT EXECUTE ON FUNCTION finnor_os.s5_consume_institution(text,jsonb) TO finnor_app;
  GRANT EXECUTE ON FUNCTION finnor_os.s5_release_untouched_institution(text) TO finnor_app;
END IF; END $$;
