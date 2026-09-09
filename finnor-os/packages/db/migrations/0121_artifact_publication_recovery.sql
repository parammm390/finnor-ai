-- Publication recovery remains append/read-back based: an ambiguous delivery can
-- resume without a blind overwrite, while verified/conflict/failure states remain
-- terminal. Binding retries converge on one exact version/node/source identity.
CREATE UNIQUE INDEX artifact_bindings_identity_key
  ON finnor_os.artifact_bindings(
    tenant_id,version_id,anchor_id,anchor_hash,target_kind,target_id,target_entity_type,target_anchor
  ) NULLS NOT DISTINCT;

CREATE OR REPLACE FUNCTION finnor_os.assert_artifact_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ref record; decision record;
BEGIN
 SELECT * INTO ref FROM finnor_os.external_refs WHERE id=NEW.external_ref_id;
 IF NOT FOUND OR ref.tenant_id<>NEW.tenant_id OR ref.internal_id IS DISTINCT FROM NEW.document_id OR ref.integration_id IS DISTINCT FROM NEW.integration_id OR ref.provider<>'microsoft_graph' THEN RAISE EXCEPTION 'artifact publication provider binding mismatch'; END IF;
 SELECT * INTO decision FROM finnor_os.authority_decisions WHERE id=NEW.authority_decision_id;
 IF NOT FOUND OR decision.tenant_id<>NEW.tenant_id THEN RAISE EXCEPTION 'artifact publication authority tenant mismatch'; END IF;
 IF TG_OP='UPDATE' AND (NEW.tenant_id<>OLD.tenant_id OR NEW.document_id<>OLD.document_id OR NEW.local_version_id<>OLD.local_version_id OR NEW.base_version_id<>OLD.base_version_id OR NEW.external_ref_id<>OLD.external_ref_id OR NEW.authority_decision_id<>OLD.authority_decision_id OR NEW.actor_id<>OLD.actor_id OR NEW.base_etag<>OLD.base_etag OR NEW.write_mode<>OLD.write_mode OR NEW.integration_id<>OLD.integration_id OR NEW.provider_binding_key<>OLD.provider_binding_key OR NEW.expected_semantic_hash<>OLD.expected_semantic_hash) THEN RAISE EXCEPTION 'artifact publication identity immutable'; END IF;
 IF TG_OP='UPDATE' AND (
   (OLD.status='prepared' AND NEW.status NOT IN ('prepared','writing','conflict','verification_failed')) OR
   (OLD.status='writing' AND NEW.status NOT IN ('writing','acknowledged','conflict','unknown_delivery','verification_failed')) OR
   (OLD.status='acknowledged' AND NEW.status NOT IN ('acknowledged','verified','verified_provider_normalized','verification_failed','unknown_delivery')) OR
   (OLD.status='unknown_delivery' AND NEW.status NOT IN ('unknown_delivery','writing','acknowledged','verified','verified_provider_normalized','conflict','verification_failed')) OR
   (OLD.status NOT IN ('prepared','writing','acknowledged','unknown_delivery') AND NEW.status<>OLD.status)
 ) THEN RAISE EXCEPTION 'invalid artifact publication state transition'; END IF;
 RETURN NEW;
END $$;
