-- Append-only repair: preserve the original finite budgets, including empty episodes.
REVOKE DELETE,TRUNCATE ON finnor_os.y1_episodes,finnor_os.y2_episodes,finnor_os.y3_episodes FROM finnor_app;
CREATE TRIGGER y1_episode_no_delete BEFORE DELETE ON finnor_os.y1_episodes
 FOR EACH ROW EXECUTE FUNCTION finnor_os.s5_immutable_record();
CREATE TRIGGER y3_episode_no_delete BEFORE DELETE ON finnor_os.y3_episodes
 FOR EACH ROW EXECUTE FUNCTION finnor_os.s5_immutable_record();

-- Global canonical writers must invalidate every affected principal's mutable head.
-- Each function uses explicit tenant predicates and a fixed, trusted search path.
ALTER FUNCTION finnor_os.y1_input_changed() SECURITY DEFINER;
ALTER FUNCTION finnor_os.y1_native_intent_guard() SECURITY DEFINER;
ALTER FUNCTION finnor_os.y2_input_changed() SECURITY DEFINER;
ALTER FUNCTION finnor_os.y2_descendant_invalidation() SECURITY DEFINER;
REVOKE ALL ON FUNCTION finnor_os.y1_input_changed(),finnor_os.y1_native_intent_guard(),
 finnor_os.y2_input_changed(),finnor_os.y2_descendant_invalidation() FROM PUBLIC,finnor_app;
CREATE INDEX y1_native_effect_origin_lookup ON finnor_os.s6_economic_obligation_origins(tenant_id,effect_id);
CREATE INDEX y1_native_action_origin_lookup ON finnor_os.s6_economic_obligation_origins(tenant_id,domain_action_id);
CREATE INDEX y2_evidence_source_lookup ON finnor_os.y2_models(tenant_id,(request->'evidence'->>'sourceId'));

-- Preserve complete Work/episode/theory scope, including writes outside HTTP.
ALTER TABLE finnor_os.work_inputs ADD CONSTRAINT y3_input_work_key UNIQUE(tenant_id,id,work_id);
ALTER TABLE finnor_os.y1_requests ADD CONSTRAINT y3_theory_owner_key UNIQUE(tenant_id,id,principal_id,work_id,work_input_id);
ALTER TABLE finnor_os.y3_episodes ADD CONSTRAINT y3_episode_owner_key UNIQUE(tenant_id,id,principal_id,work_id);
ALTER TABLE finnor_os.y3_requests
 ADD CONSTRAINT y3_exact_work_input FOREIGN KEY(tenant_id,work_input_id,work_id) REFERENCES finnor_os.work_inputs(tenant_id,id,work_id),
 ADD CONSTRAINT y3_exact_episode FOREIGN KEY(tenant_id,episode_id,principal_id,work_id) REFERENCES finnor_os.y3_episodes(tenant_id,id,principal_id,work_id),
 ADD CONSTRAINT y3_exact_theory FOREIGN KEY(tenant_id,theory_id,principal_id,work_id,work_input_id) REFERENCES finnor_os.y1_requests(tenant_id,id,principal_id,work_id,work_input_id),
 ADD CONSTRAINT y3_protocol_owner_key UNIQUE(tenant_id,id,principal_id,episode_id),
 ADD CONSTRAINT y3_protocol_episode_key UNIQUE(tenant_id,id,episode_id);
ALTER TABLE finnor_os.s8_interaction_admissions ADD CONSTRAINT y3_admission_owner
 FOREIGN KEY(tenant_id,protocol_id,principal_id,episode_id) REFERENCES finnor_os.y3_requests(tenant_id,id,principal_id,episode_id);
ALTER TABLE finnor_os.s4_interaction_terms
 ADD CONSTRAINT y3_terms_owner FOREIGN KEY(tenant_id,protocol_id,principal_id,episode_id) REFERENCES finnor_os.y3_requests(tenant_id,id,principal_id,episode_id),
 ADD CONSTRAINT y3_terms_protocol_key UNIQUE(tenant_id,id,protocol_id,episode_id);
ALTER TABLE finnor_os.s4_interaction_runs
 ADD CONSTRAINT y3_run_owner FOREIGN KEY(tenant_id,protocol_id,principal_id,episode_id) REFERENCES finnor_os.y3_requests(tenant_id,id,principal_id,episode_id),
 ADD CONSTRAINT y3_run_terms FOREIGN KEY(tenant_id,terms_id,protocol_id,episode_id) REFERENCES finnor_os.s4_interaction_terms(tenant_id,id,protocol_id,episode_id),
 ADD CONSTRAINT y3_run_protocol_key UNIQUE(tenant_id,id,protocol_id,episode_id);
-- History and consent principals are participants, intentionally distinct from the owner.
ALTER TABLE finnor_os.s4_interaction_history ADD CONSTRAINT y3_history_run
 FOREIGN KEY(tenant_id,run_id,protocol_id,episode_id) REFERENCES finnor_os.s4_interaction_runs(tenant_id,id,protocol_id,episode_id);
ALTER TABLE finnor_os.s4_interaction_consents ADD CONSTRAINT y3_consent_terms
 FOREIGN KEY(tenant_id,terms_id,protocol_id,episode_id) REFERENCES finnor_os.s4_interaction_terms(tenant_id,id,protocol_id,episode_id);

-- Explicit sharing: the owner and named actors can read collaboration records.
-- Private participant projections remain enforced by the authenticated owner API.
CREATE FUNCTION finnor_os.y3_protocol_visible(p_tenant uuid,p_protocol uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT p_tenant=finnor_os.request_tenant_id() AND EXISTS(
  SELECT 1 FROM finnor_os.y3_requests r WHERE r.tenant_id=p_tenant AND r.id=p_protocol
   AND (r.principal_id=finnor_os.request_authenticated_user_uuid() OR
    r.request->'problem'->'participants' @> jsonb_build_array(jsonb_build_object('principalId',finnor_os.request_authenticated_user_uuid()::text))))
$$;
REVOKE ALL ON FUNCTION finnor_os.y3_protocol_visible(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.y3_protocol_visible(uuid,uuid) TO finnor_app;
ALTER POLICY y3_tenant ON finnor_os.y3_requests
 USING(finnor_os.y3_protocol_visible(tenant_id,id))
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=finnor_os.request_authenticated_user_uuid());
ALTER POLICY y3_tenant ON finnor_os.s4_interaction_consents
 USING(finnor_os.y3_protocol_visible(tenant_id,protocol_id))
 WITH CHECK(finnor_os.y3_protocol_visible(tenant_id,protocol_id) AND principal_id=finnor_os.request_authenticated_user_uuid());
ALTER POLICY y3_tenant ON finnor_os.s4_interaction_runs
 USING(finnor_os.y3_protocol_visible(tenant_id,protocol_id))
 WITH CHECK(finnor_os.y3_protocol_visible(tenant_id,protocol_id) AND principal_id=finnor_os.request_authenticated_user_uuid());
ALTER POLICY y3_tenant ON finnor_os.s4_interaction_history
 USING(finnor_os.y3_protocol_visible(tenant_id,protocol_id))
 WITH CHECK(finnor_os.y3_protocol_visible(tenant_id,protocol_id) AND principal_id=finnor_os.request_authenticated_user_uuid());
