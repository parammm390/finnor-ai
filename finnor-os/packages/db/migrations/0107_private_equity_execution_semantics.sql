-- Private Equity Phase 4: let the existing Core action/approval/BusinessEffect
-- runtime present its exact in-flight DecisionReceipt to the PE2 mutation guard.
-- PE2 remains the state owner; this only joins its original capability names to
-- the action:* names used by the universal authority boundary.

-- The universal scope guard normally requires every canonical target to exist at
-- BusinessEffect compilation time. PE create mutations intentionally reserve the
-- new entity's UUID as the DomainAction UUID, so permit only those exact
-- action/type pairs as tenant-owned proposed targets. All existing targets still
-- resolve through canonical_entity_tenant and every source/Work/policy/binding
-- retains the original tenant checks.
CREATE OR REPLACE FUNCTION finnor_os.assert_business_effect_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE
  item jsonb;
  binding jsonb;
  kind text;
  target_type text;
  raw_id text;
  target_id uuid;
  resolved uuid;
  source_id uuid;
  source_action_type text;
BEGIN
  source_action_type := NEW.effect#>>'{source,actionType}';
  IF NEW.domain_action_id IS NOT NULL
    AND NEW.effect#>>'{source,domainActionId}' IS DISTINCT FROM NEW.domain_action_id::text
  THEN RAISE EXCEPTION 'Business Effect source action does not match its canonical action reference';
  END IF;

  BEGIN source_id := nullif(NEW.effect#>>'{source,domainActionId}','')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Business Effect source action is invalid'; END;
  IF source_id IS NOT NULL THEN
    SELECT tenant_id INTO resolved FROM finnor_os.domain_actions WHERE id=source_id;
    IF resolved IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Business Effect source action crosses tenant boundary or does not exist'; END IF;
  END IF;

  BEGIN source_id := nullif(NEW.effect#>>'{source,workId}','')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Business Effect Work reference is invalid'; END;
  IF source_id IS NOT NULL THEN
    resolved := NULL; SELECT tenant_id INTO resolved FROM finnor_os.works WHERE id=source_id;
    IF resolved IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Business Effect Work reference crosses tenant boundary or does not exist'; END IF;
  END IF;

  BEGIN source_id := nullif(NEW.effect#>>'{source,objectiveStepId}','')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Business Effect objective step reference is invalid'; END;
  IF source_id IS NOT NULL THEN
    resolved := NULL; SELECT tenant_id INTO resolved FROM finnor_os.work_objective_steps WHERE id=source_id;
    IF resolved IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Business Effect objective step crosses tenant boundary or does not exist'; END IF;
  END IF;

  BEGIN source_id := nullif(NEW.effect#>>'{authority,policyId}','')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Business Effect policy reference is invalid'; END;
  IF source_id IS NOT NULL THEN
    resolved := NULL; SELECT tenant_id INTO resolved FROM finnor_os.domain_policies WHERE id=source_id;
    IF resolved IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Business Effect policy crosses tenant boundary or does not exist'; END IF;
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(coalesce(NEW.effect->'targets','[]'::jsonb)) LOOP
    kind := item->>'kind'; target_type := item->>'type'; raw_id := item->>'id'; resolved := NULL; target_id := NULL;
    IF raw_id IS NULL OR target_type IS NULL OR kind IS NULL THEN RAISE EXCEPTION 'Business Effect target is incomplete'; END IF;
    BEGIN target_id := raw_id::uuid; EXCEPTION WHEN invalid_text_representation THEN target_id := NULL; END;
    IF kind='party' THEN
      IF target_id IS NULL THEN RAISE EXCEPTION 'Business Effect PartyRef is invalid'; END IF;
      resolved := finnor_os.party_ref_tenant(target_type,target_id);
    ELSIF kind='entity' THEN
      IF target_type='inventory_item' THEN
        SELECT tenant_id INTO resolved FROM finnor_os.inventory_items WHERE sku=raw_id AND tenant_id=NEW.tenant_id;
      ELSIF target_type='location' THEN
        SELECT tenant_id INTO resolved FROM finnor_os.tenant_locations WHERE id=target_id;
      ELSIF target_type='objective_loop' THEN
        SELECT tenant_id INTO resolved FROM finnor_os.work_objective_loops WHERE id=target_id;
      ELSIF target_type='communication_identity' THEN
        SELECT tenant_id INTO resolved FROM finnor_os.communication_identities WHERE id=target_id;
      ELSIF target_type='auth_profile' THEN
        SELECT tenant_id INTO resolved FROM finnor_os.auth_profiles WHERE id=target_id;
      ELSIF target_type='application_account' THEN
        SELECT tenant_id INTO resolved FROM finnor_os.application_accounts WHERE id=target_id;
      ELSE
        IF target_id IS NULL THEN RAISE EXCEPTION 'Business Effect canonical entity reference is invalid'; END IF;
        resolved := finnor_os.canonical_entity_tenant(target_type,target_id);
        IF resolved IS NULL AND target_id=NEW.domain_action_id AND (
          (source_action_type='open_workstream' AND target_type='pe_workstream') OR
          (source_action_type='create_deal_request' AND target_type='pe_request') OR
          (source_action_type='record_finding' AND target_type='pe_finding') OR
          (source_action_type='raise_deal_risk' AND target_type='pe_deal_risk') OR
          (source_action_type='link_deal_dependency' AND target_type='pe_dependency') OR
          (source_action_type='create_closing_condition' AND target_type='pe_closing_condition')
        ) THEN
          SELECT tenant_id INTO resolved FROM finnor_os.domain_actions
           WHERE id=target_id AND tenant_id=NEW.tenant_id AND action_type=source_action_type;
        END IF;
      END IF;
    ELSIF kind='resource' AND target_type='communication_identity' THEN
      SELECT tenant_id INTO resolved FROM finnor_os.communication_identities WHERE id=target_id;
    ELSIF kind='resource' AND target_type='auth_profile' THEN
      SELECT tenant_id INTO resolved FROM finnor_os.auth_profiles WHERE id=target_id;
    ELSIF kind='resource' AND target_type='application_account' THEN
      SELECT tenant_id INTO resolved FROM finnor_os.application_accounts WHERE id=target_id;
    ELSIF kind='resource' AND target_type='business_effect' THEN
      SELECT tenant_id INTO resolved FROM finnor_os.business_effects WHERE id=target_id;
    ELSIF kind='resource' AND target_type IN ('proposed_business_change','phone_endpoint','email_endpoint','recipient_endpoint') THEN
      resolved := NEW.tenant_id;
    ELSE
      RAISE EXCEPTION 'Unsupported Business Effect target kind/type: %/%',kind,target_type;
    END IF;
    IF resolved IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Business Effect target crosses tenant boundary or does not exist'; END IF;
  END LOOP;

  FOR binding IN SELECT value FROM jsonb_array_elements(coalesce(NEW.effect->'bindings','[]'::jsonb)) LOOP
    IF binding->>'communicationIdentityId' IS NOT NULL THEN
      resolved := NULL; SELECT tenant_id INTO resolved FROM finnor_os.communication_identities WHERE id=(binding->>'communicationIdentityId')::uuid;
      IF resolved IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Business Effect communication identity crosses tenant boundary or does not exist'; END IF;
    END IF;
    IF binding->>'authProfileId' IS NOT NULL THEN
      resolved := NULL; SELECT tenant_id INTO resolved FROM finnor_os.auth_profiles WHERE id=(binding->>'authProfileId')::uuid;
      IF resolved IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Business Effect auth profile crosses tenant boundary or does not exist'; END IF;
    END IF;
    IF binding->>'applicationAccountId' IS NOT NULL THEN
      resolved := NULL; SELECT tenant_id INTO resolved FROM finnor_os.application_accounts WHERE id=(binding->>'applicationAccountId')::uuid;
      IF resolved IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Business Effect application account crosses tenant boundary or does not exist'; END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION finnor_os.assert_business_effect_scope() FROM PUBLIC;
DO $grant_scope$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    GRANT EXECUTE ON FUNCTION finnor_os.assert_business_effect_scope() TO finnor_app;
  END IF;
END $grant_scope$;

CREATE OR REPLACE FUNCTION finnor_os.pe_governance_proof_valid(
  p_tenant uuid,p_resource_type text,p_resource_id uuid,p_capability text,
  p_authority_decision uuid,p_decision_receipt uuid,p_require_current_revision boolean DEFAULT false,
  p_require_approval boolean DEFAULT false
) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,finnor_os AS $$
DECLARE decision_row finnor_os.authority_decisions%ROWTYPE;
DECLARE current_revision integer;
DECLARE action_capability text;
DECLARE approval_mandatory boolean;
DECLARE receipt_valid boolean;
BEGIN
  IF p_authority_decision IS NULL THEN RETURN false; END IF;
  action_capability := CASE p_capability
    WHEN 'private_equity:waive_closing_condition' THEN 'action:waive_closing_condition'
    WHEN 'private_equity:close_deal' THEN 'action:declare_deal_closed'
    WHEN 'private_equity:terminate_deal' THEN 'action:terminate_deal'
    ELSE NULL
  END;
  SELECT * INTO decision_row FROM finnor_os.authority_decisions
  WHERE id=p_authority_decision AND tenant_id=p_tenant
    AND capability IN (p_capability,action_capability)
    AND resource_type=p_resource_type AND resource_id=p_resource_id;
  IF NOT FOUND THEN RETURN false; END IF;
  -- P2 repository callers keep their existing governance contract.  The new
  -- Phase-4 DomainActions are the surface with unconditional human-approval
  -- floors, so only their action:* authority decisions trigger that floor.
  approval_mandatory := p_require_approval OR decision_row.capability IN (
    'action:waive_closing_condition','action:declare_deal_closed'
  );
  IF p_require_current_revision THEN
    SELECT coalesce((SELECT revision FROM finnor_os.authority_states WHERE tenant_id=p_tenant),1) INTO current_revision;
    IF decision_row.authority_revision<>current_revision THEN RETURN false; END IF;
  END IF;

  IF p_decision_receipt IS NULL THEN RETURN decision_row.outcome='allowed' AND NOT approval_mandatory; END IF;
  SELECT EXISTS (
    SELECT 1
    FROM finnor_os.decision_receipts r
    JOIN finnor_os.domain_actions da
      ON da.tenant_id=r.tenant_id AND da.id=r.domain_action_id
    WHERE r.id=p_decision_receipt AND r.tenant_id=p_tenant
      AND decision_row.domain_action_id IS NOT NULL
      AND r.domain_action_id=decision_row.domain_action_id
      AND da.status IN ('executing','completed')
      AND r.business_effect_id IS NOT DISTINCT FROM decision_row.business_effect_id
      AND r.authorized_effect_hash IS NOT DISTINCT FROM decision_row.business_effect_hash
      AND (r.failure IS NULL)
      AND (r.finalized_at IS NULL OR r.actual_result IS NOT NULL)
  ) INTO receipt_valid;
  IF NOT receipt_valid THEN RETURN false; END IF;

  IF decision_row.outcome='allowed' AND NOT approval_mandatory THEN RETURN true; END IF;
  IF decision_row.outcome<>'approval_required' THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1
    FROM finnor_os.authority_approval_requests ar
    JOIN finnor_os.decision_receipts r
      ON r.tenant_id=ar.tenant_id AND r.domain_action_id=ar.domain_action_id
    WHERE ar.tenant_id=p_tenant AND ar.authority_decision_id=p_authority_decision
      AND ar.status='approved' AND r.id=p_decision_receipt
      AND coalesce((r.approval->>'required')::boolean,false)
      AND coalesce(btrim(r.approval->>'approvedBy'),'')<>''
      AND ar.business_effect_id IS NOT DISTINCT FROM r.business_effect_id
      AND ar.business_effect_hash IS NOT DISTINCT FROM r.authorized_effect_hash
  );
END $$;

REVOKE ALL ON FUNCTION finnor_os.pe_governance_proof_valid(uuid,text,uuid,text,uuid,uuid,boolean,boolean) FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    GRANT EXECUTE ON FUNCTION finnor_os.pe_governance_proof_valid(uuid,text,uuid,text,uuid,uuid,boolean,boolean) TO finnor_app;
  END IF;
END $grant$;

COMMENT ON FUNCTION finnor_os.pe_governance_proof_valid(uuid,text,uuid,text,uuid,uuid,boolean,boolean) IS
  'Validates PE2 governance or the exact Core Phase-4 action approval/BusinessEffect/DecisionReceipt while execution is in flight.';
