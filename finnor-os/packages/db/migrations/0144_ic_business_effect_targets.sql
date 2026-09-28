-- The IC and underwriting actions pin immutable P3/P4 records in their exact
-- Business Effects. Verify those records in their owning tenant tables. A new IC
-- result target may use only its source action UUID and matching action/type pair;
-- other proposed or cross-tenant target IDs remain rejected.
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
      ELSIF target_type='document_version' THEN
        SELECT tenant_id INTO resolved FROM finnor_os.document_versions WHERE id=target_id;
      ELSIF target_type='underwriting_run' THEN
        SELECT tenant_id INTO resolved FROM finnor_os.underwriting_runs WHERE id=target_id;
      ELSIF target_type='underwriting_model_version' THEN
        SELECT tenant_id INTO resolved FROM finnor_os.underwriting_model_versions WHERE id=target_id;
      ELSIF target_type='underwriting_scenario' THEN
        SELECT tenant_id INTO resolved FROM finnor_os.underwriting_scenarios WHERE id=target_id;
      ELSIF target_type='pe_ic_committee_config_version' THEN
        SELECT tenant_id INTO resolved FROM finnor_os.pe_ic_committee_config_versions WHERE id=target_id;
      ELSE
        IF target_id IS NULL THEN RAISE EXCEPTION 'Business Effect canonical entity reference is invalid'; END IF;
        resolved := finnor_os.canonical_entity_tenant(target_type,target_id);
        IF resolved IS NULL AND target_id=NEW.domain_action_id AND (
          (source_action_type='open_workstream' AND target_type='pe_workstream') OR
          (source_action_type='create_deal_request' AND target_type='pe_request') OR
          (source_action_type='record_finding' AND target_type='pe_finding') OR
          (source_action_type='raise_deal_risk' AND target_type='pe_deal_risk') OR
          (source_action_type='link_deal_dependency' AND target_type='pe_dependency') OR
          (source_action_type='create_closing_condition' AND target_type='pe_closing_condition') OR
          (source_action_type='open_ic_case' AND target_type='pe_ic_case') OR
          (source_action_type='select_ic_memo_version' AND target_type='pe_ic_memo') OR
          (source_action_type='create_ic_question' AND target_type='pe_ic_question') OR
          (source_action_type='prepare_ic_decision_proposal' AND target_type='pe_ic_decision_proposal')
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
