-- Keep one collaboration guard without accessing fields absent from the trigger's
-- row type. to_jsonb makes the table-specific branch explicit and safe.
CREATE OR REPLACE FUNCTION finnor_os.assert_artifact_comment_review() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE related_version uuid; related_id uuid;
BEGIN
  IF TG_TABLE_NAME='artifact_comments' THEN
    related_id:=nullif(to_jsonb(NEW)->>'parent_comment_id','')::uuid;
    IF related_id IS NOT NULL THEN
      SELECT version_id INTO related_version FROM finnor_os.artifact_comments
      WHERE tenant_id=NEW.tenant_id AND id=related_id;
      IF related_version IS DISTINCT FROM NEW.version_id THEN
        RAISE EXCEPTION 'comment reply must stay on the same artifact version';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='artifact_reviews' THEN
    related_id:=nullif(to_jsonb(NEW)->>'comment_id','')::uuid;
    IF related_id IS NOT NULL THEN
      SELECT version_id INTO related_version FROM finnor_os.artifact_comments
      WHERE tenant_id=NEW.tenant_id AND id=related_id;
      IF related_version IS DISTINCT FROM NEW.version_id THEN
        RAISE EXCEPTION 'comment resolution must stay on the same artifact version';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
