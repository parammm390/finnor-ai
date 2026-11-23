-- Forward-only integration repair of the Z1 and Z5 source-change fences.
-- No table, policy, grant, resource, signer or history change.
--
-- Failure models observed on the integrated candidate before this repair:
--  1. A source owner whose app.user_id is not a UUID (for example
--     system:microsoft-graph-worker appending an evidence source version) fired
--     z1_original_cut_changed(). Its UPDATE of finnor_os.z1_requests evaluated the
--     principal policy, whose nullif(current_setting('app.user_id',true),'')::uuid
--     raised 22P02 and aborted the unrelated source owner's transaction.
--  2. A source owner who is a different employee fired the same UPDATE under the
--     invoker's row security. It matched zero rows, so a cut changed by another
--     principal left the original Z1 episode current at commit.
--  3. z5_native_changed() raised the same 22P02 for any non-UUID actor that wrote
--     a Work input or the authority state.
--
-- Z1 invalidation is tenant-wide, as in the P4 and M3 source-change fences, so it
-- runs as definer with a pinned search_path and is not callable by PUBLIC.
-- Z5 keeps principal-private rows (the next claim, read or use of another
-- employee's request detects the new cut). It only skips the statement for an
-- actor that cannot own a Z5 episode, which row security would also have hidden.
CREATE OR REPLACE FUNCTION finnor_os.z1_original_cut_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_TABLE_NAME='work_inputs' THEN
  UPDATE finnor_os.z1_requests q SET status='INVALIDATED'
   WHERE q.tenant_id=NEW.tenant_id AND q.status NOT IN('CANCELLED','INVALIDATED')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.cuts) c WHERE c->>'workId'=NEW.work_id::text AND c->>'inputId'<>NEW.id::text);
 ELSIF TG_TABLE_NAME='evidence_source_versions' THEN
  UPDATE finnor_os.z1_requests q SET status='INVALIDATED'
   WHERE q.tenant_id=NEW.tenant_id AND q.status NOT IN('CANCELLED','INVALIDATED')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.cuts) c WHERE
    c->'declaration'->>'sourceId'=NEW.source_id::text AND c->'declaration'->>'versionId'<>NEW.id::text
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(c->'sourcePins') p WHERE p->>'sourceId'=NEW.source_id::text AND p->>'versionId'<>NEW.id::text));
 ELSE
  UPDATE finnor_os.z1_requests SET status='INVALIDATED'
   WHERE tenant_id=NEW.tenant_id AND status NOT IN('CANCELLED','INVALIDATED');
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION finnor_os.z1_original_cut_changed() FROM PUBLIC;

CREATE OR REPLACE FUNCTION finnor_os.z5_native_changed() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,finnor_os AS $$
DECLARE actor uuid;
BEGIN
 BEGIN
  actor:=nullif(current_setting('app.user_id',true),'')::uuid;
 EXCEPTION WHEN invalid_text_representation THEN
  RETURN NEW;
 END;
 IF actor IS NULL THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='work_inputs' THEN
  UPDATE finnor_os.z5_link_requests SET status='STALE',generation=generation+1
   WHERE tenant_id=NEW.tenant_id AND work_id=NEW.work_id AND work_input_id<>NEW.id
    AND status NOT IN('STALE','REVOKED','CANCELLED');
 ELSE
  UPDATE finnor_os.z5_link_requests SET status='STALE',generation=generation+1
   WHERE tenant_id=NEW.tenant_id AND status NOT IN('STALE','REVOKED','CANCELLED');
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION finnor_os.z5_native_changed() FROM PUBLIC;
