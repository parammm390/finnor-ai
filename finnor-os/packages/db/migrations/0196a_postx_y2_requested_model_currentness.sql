-- Preserve the applied Y2 migration identity and upgrade existing databases.
-- Cancelling a requested model also fences uses that executed its fallback.
CREATE OR REPLACE FUNCTION finnor_os.y2_descendant_invalidation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF NEW.status IN('INVALIDATED','CANCELLED') THEN
  UPDATE finnor_os.y2_uses SET status='INVALIDATED',generation=generation+1
   WHERE tenant_id=NEW.tenant_id AND (model_id=NEW.id OR requested_model_id=NEW.id)
    AND status NOT IN('INVALIDATED','CANCELLED') AND NOT cancelled;
 END IF;
 RETURN NEW;
END $$;

UPDATE finnor_os.y2_uses u SET status='INVALIDATED',generation=generation+1
 WHERE u.status NOT IN('INVALIDATED','CANCELLED') AND NOT u.cancelled
  AND EXISTS(SELECT 1 FROM finnor_os.y2_models m
   WHERE m.tenant_id=u.tenant_id AND m.id=u.requested_model_id
    AND (m.cancelled OR m.status IN('INVALIDATED','CANCELLED')));
