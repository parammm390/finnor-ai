-- Z3 S4 executable selection. One retained, once-only record per canonical
-- application composition step that the checked Z3 strategy selected for the
-- application owner. The row names the work; it never executes it. The
-- application owner consumes it under its own durable claim.
-- Applies after postz_zi_integrated_source_change_fences.sql by bytewise
-- filename order (the name is chosen to sort after the current head).
CREATE TABLE finnor_os.z3_application_selections(
 tenant_id uuid NOT NULL,id uuid NOT NULL,principal_id uuid NOT NULL,
 session_id uuid NOT NULL,parent_session_id uuid NOT NULL,
 work_id uuid NOT NULL,work_input_id uuid NOT NULL,
 composition_ref jsonb NOT NULL,composition_digest text NOT NULL CHECK(composition_digest~'^[a-f0-9]{64}$'),
 step_id text NOT NULL CHECK(char_length(step_id) BETWEEN 1 AND 256),
 step_index integer NOT NULL CHECK(step_index>=0),
 operation_id text NOT NULL CHECK(char_length(operation_id) BETWEEN 1 AND 256),
 semantic_revision text NOT NULL CHECK(char_length(semantic_revision) BETWEEN 1 AND 256),
 original_grant_ref jsonb NOT NULL,
 z3_session_id uuid NOT NULL,z3_edge_index integer NOT NULL CHECK(z3_edge_index>=0),
 z3_cursor_digest text NOT NULL CHECK(z3_cursor_digest~'^[a-f0-9]{64}$'),
 z3_map_digest text NOT NULL CHECK(z3_map_digest~'^[a-f0-9]{64}$'),
 z3_job_id uuid NOT NULL,z3_claim_token_digest text NOT NULL CHECK(z3_claim_token_digest~'^[a-f0-9]{64}$'),
 z3_claim_fence bigint NOT NULL CHECK(z3_claim_fence>0),
 z3_delivery_attempt_id uuid NOT NULL,z3_session_generation integer NOT NULL CHECK(z3_session_generation>0),
 status text NOT NULL DEFAULT 'SELECTED'
  CHECK(status IN('SELECTED','CONSUMING','RESULT_RETAINED','REFUSED','STALE')),
 reason text,
 x2_job_id uuid,x2_claim_token_digest text CHECK(x2_claim_token_digest IS NULL OR x2_claim_token_digest~'^[a-f0-9]{64}$'),
 x2_claim_fence bigint CHECK(x2_claim_fence IS NULL OR x2_claim_fence>0),
 x2_delivery_attempt_id uuid,
 receipt_ref jsonb,receipt_digest text CHECK(receipt_digest IS NULL OR receipt_digest~'^[a-f0-9]{64}$'),
 deadline_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id,session_id) REFERENCES finnor_os.application_semantics_sessions(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,parent_session_id) REFERENCES finnor_os.application_semantics_sessions(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,z3_session_id) REFERENCES finnor_os.z3_viability_sessions(tenant_id,id),
 CHECK(session_id<>parent_session_id),
 CHECK((status='RESULT_RETAINED')=(receipt_ref IS NOT NULL AND receipt_digest IS NOT NULL))
);
-- A Z3 edge selects a step once; a duplicate delivery re-reads this row.
CREATE UNIQUE INDEX z3_application_selection_edge ON finnor_os.z3_application_selections
 (tenant_id,principal_id,session_id,composition_digest,step_id,z3_cursor_digest,z3_edge_index);
-- Two different Z3 edges can never both hold a live selection of one step.
CREATE UNIQUE INDEX z3_application_selection_live_step ON finnor_os.z3_application_selections
 (tenant_id,principal_id,session_id,composition_digest,step_id)
 WHERE status IN('SELECTED','CONSUMING','RESULT_RETAINED');
CREATE INDEX z3_application_selection_session ON finnor_os.z3_application_selections
 (tenant_id,principal_id,session_id,created_at,id);

CREATE FUNCTION finnor_os.z3_application_selection_progress() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Z3 application selection is retained'; END IF;
 IF to_jsonb(NEW)-ARRAY['status','reason','x2_job_id','x2_claim_token_digest','x2_claim_fence','x2_delivery_attempt_id',
     'receipt_ref','receipt_digest','updated_at']
  IS DISTINCT FROM
    to_jsonb(OLD)-ARRAY['status','reason','x2_job_id','x2_claim_token_digest','x2_claim_fence','x2_delivery_attempt_id',
     'receipt_ref','receipt_digest','updated_at']
 THEN RAISE EXCEPTION 'Z3 application selection preimage cannot change'; END IF;
 IF OLD.status IN('RESULT_RETAINED','REFUSED','STALE') AND NEW.status IS DISTINCT FROM OLD.status
  THEN RAISE EXCEPTION 'Z3 application selection terminal state cannot change'; END IF;
 IF OLD.status IN('RESULT_RETAINED','REFUSED','STALE')
  AND (NEW.receipt_ref IS DISTINCT FROM OLD.receipt_ref OR NEW.receipt_digest IS DISTINCT FROM OLD.receipt_digest
   OR NEW.reason IS DISTINCT FROM OLD.reason)
  THEN RAISE EXCEPTION 'Z3 application selection result cannot be rewritten'; END IF;
 IF OLD.status='SELECTED' AND NEW.status NOT IN('SELECTED','CONSUMING','REFUSED','STALE')
  OR OLD.status='CONSUMING' AND NEW.status NOT IN('CONSUMING','RESULT_RETAINED','REFUSED','STALE')
  THEN RAISE EXCEPTION 'Z3 application selection transition invalid'; END IF;
 IF OLD.x2_claim_fence IS NOT NULL AND (NEW.x2_claim_fence IS NULL OR NEW.x2_claim_fence<OLD.x2_claim_fence)
  THEN RAISE EXCEPTION 'Z3 application selection application claim fence cannot retreat'; END IF;
 IF OLD.receipt_ref IS NOT NULL AND NEW.receipt_ref IS DISTINCT FROM OLD.receipt_ref
  THEN RAISE EXCEPTION 'Z3 application selection receipt is immutable'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION finnor_os.z3_application_selection_progress() FROM PUBLIC;
CREATE TRIGGER z3_application_selection_progress BEFORE UPDATE OR DELETE ON finnor_os.z3_application_selections
 FOR EACH ROW EXECUTE FUNCTION finnor_os.z3_application_selection_progress();
ALTER TABLE finnor_os.z3_application_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.z3_application_selections FORCE ROW LEVEL SECURITY;
CREATE POLICY z3_scope ON finnor_os.z3_application_selections
 USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON finnor_os.z3_application_selections TO finnor_app;

-- Same function as postz_z0_institution_application_bridge.sql with exactly one
-- additional accepting branch: a governed execution child of an accepted
-- institution-origin acquisition parent, and only for the one canonical step
-- that a live Z3 selection names. Every other branch and refusal is unchanged,
-- z0_s5_application_frame is untouched, and no allowance is created.
CREATE OR REPLACE FUNCTION finnor_os.z0_s5_application_consumption(p_body jsonb,p_decision uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
#variable_conflict use_variable
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
   AND NOT EXISTS(SELECT 1 FROM finnor_os.application_semantics_sessions c
    JOIN finnor_os.application_semantics_sessions p ON p.tenant_id=c.tenant_id AND p.principal_id=c.principal_id
      AND p.id=c.parent_id
    JOIN finnor_os.z3_application_selections sel ON sel.tenant_id=c.tenant_id AND sel.principal_id=c.principal_id
      AND sel.session_id=c.id
    WHERE c.tenant_id=t AND c.principal_id=u AND c.id<>c.parent_id AND p.id=p.parent_id
      AND c.allocation_ref=p_body->'certificateRef' AND c.reservation_ref=parent->'ref'
      AND c.original_parent_ref=cert->'originalParentRef'
      AND p.allocation_ref=c.allocation_ref AND p.reservation_ref=c.reservation_ref
      AND p.original_parent_ref=c.original_parent_ref
      AND p.status='MODEL_READY'
      AND EXISTS(SELECT 1 FROM finnor_os.application_semantics_events e WHERE e.tenant_id=t AND e.principal_id=u
        AND e.session_id=p.id AND e.kind='S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED')
      AND c.parent->'institutionalOriginRef' IS NOT NULL
      AND c.parent->'institutionalOriginRef' IS NOT DISTINCT FROM p.parent->'institutionalOriginRef'
      AND c.parent->'viabilityGoverned'->>'schema'='finnor.s4.z3-governed-origin-child.v1'
      AND p_body->>'nodeId'=c.id::text||':'||sel.step_id
      AND sel.status IN('SELECTED','CONSUMING')
      AND c.cancel_requested_at IS NULL AND c.deadline_at>clock_timestamp()
      AND c.status NOT IN('COMPLETED','MODEL_READY','CANCELLED','FAILED','STALE','BLOCKED'))
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
GRANT EXECUTE ON FUNCTION finnor_os.z0_s5_application_consumption(jsonb,uuid) TO finnor_app,finnor_worker;
DO $$ BEGIN
 IF NOT has_function_privilege('finnor_worker','finnor_os.z0_s5_application_consumption(jsonb,uuid)','EXECUTE')
  OR NOT has_function_privilege('finnor_app','finnor_os.z0_s5_application_consumption(jsonb,uuid)','EXECUTE')
  OR has_function_privilege('public','finnor_os.z0_s5_application_consumption(jsonb,uuid)','EXECUTE')
 THEN RAISE EXCEPTION 'S5 application consumption privileges changed'; END IF;
END $$;
