-- The specialist source catalogue predates the Z1 policies. Preserve their
-- per-principal restrictions when the specialist readers gain policy-helper ACLs.
GRANT EXECUTE ON FUNCTION finnor_os.bilateral_evidence_scope_allowed(jsonb),
 finnor_os.primary_evidence_profile_ref_allowed(jsonb),
 finnor_os.primary_evidence_scope_allowed(text,text),finnor_os.z1_s5_visible(text)
 TO finnor_specialist_candidate,finnor_specialist_owner;

CREATE POLICY specialist_z1_proposal_privacy ON finnor_os.s5_proposals
 AS RESTRICTIVE FOR SELECT TO finnor_specialist_candidate,finnor_specialist_owner
 USING(problem->>'schema' IS DISTINCT FROM 'finnor.s5.z1-original-work-problem.v1'
  OR principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY specialist_z1_origin_privacy ON finnor_os.s5_reservation_origins
 AS RESTRICTIVE FOR SELECT TO finnor_specialist_candidate,finnor_specialist_owner
 USING(body->>'schema'<>'finnor.s5.z1-original-budget.v1'
  OR principal_id=nullif(current_setting('app.user_id',true),'')::uuid);

DO $$ DECLARE t text;column_name text;BEGIN
 FOREACH t IN ARRAY ARRAY['s5_reservations','s5_consumptions','s5_consumption_states','s5_governed_resource_charges','s5_history'] LOOP
  column_name:=CASE WHEN t='s5_history' THEN 'subject_id' WHEN t='s5_consumption_states' THEN 'consumption_id' ELSE 'reservation_id' END;
  EXECUTE format('CREATE POLICY specialist_z1_subject_privacy ON finnor_os.%I
   AS RESTRICTIVE FOR SELECT TO finnor_specialist_candidate,finnor_specialist_owner
   USING(finnor_os.z1_s5_visible(%I))',t,column_name);
 END LOOP;
END $$;
