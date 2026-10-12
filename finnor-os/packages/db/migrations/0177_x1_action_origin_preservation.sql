-- Authority readback may refresh its decision projection, but must never erase
-- or retarget an institution obligation's immutable execution/currentness origin.
-- This additive guard leaves existing ordinary/non-institution actions unchanged.
CREATE FUNCTION finnor_os.x1_preserve_action_origin() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE k text;
BEGIN
 IF OLD.authority_context->>'kind' IS DISTINCT FROM 'institution_duty' THEN RETURN NEW; END IF;
 IF NEW.initiated_by IS DISTINCT FROM OLD.initiated_by
   OR NEW.work_id IS DISTINCT FROM OLD.work_id THEN
  RAISE EXCEPTION 'X1_ORIGINAL_ACTION_ORIGIN_IMMUTABLE';
 END IF;
 FOREACH k IN ARRAY ARRAY['kind','principal','programId','compilerRequestId','stableIdentity','workInputId'] LOOP
  IF NEW.authority_context->k IS DISTINCT FROM OLD.authority_context->k THEN
   RAISE EXCEPTION 'X1_ORIGINAL_ACTION_ORIGIN_IMMUTABLE';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER x1_action_origin_immutable BEFORE UPDATE OF authority_context,initiated_by,work_id
 ON finnor_os.domain_actions FOR EACH ROW EXECUTE FUNCTION finnor_os.x1_preserve_action_origin();
