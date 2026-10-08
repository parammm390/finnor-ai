-- Forward-only proposal, with the final registry ordinal assigned by C.
-- An encrypted logical restore inherits the earliest accepted ancestor clock.
CREATE FUNCTION finnor_os.p3_episode_deadline(p_tenant uuid,p_principal uuid,p_branch uuid)
 RETURNS timestamptz LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE h finnor_os.p3_requests;cp finnor_os.p3_artifacts;cursor_id uuid:=p_branch;
 visited uuid[]:=ARRAY[]::uuid[];deadline timestamptz:='infinity';episode_work_id uuid;
BEGIN
 FOR depth IN 1..64 LOOP
  IF cursor_id=ANY(visited) THEN RAISE EXCEPTION 'P3 checkpoint ancestry cycle';END IF;
  visited:=array_append(visited,cursor_id);
  SELECT r.* INTO h FROM finnor_os.p3_requests r
   WHERE r.id=cursor_id AND r.tenant_id=p_tenant AND r.principal_id=p_principal;
  IF h.id IS NULL OR (episode_work_id IS NOT NULL AND h.work_id<>episode_work_id) THEN
   RAISE EXCEPTION 'P3 private episode ancestry unavailable';END IF;
  episode_work_id:=h.work_id;
  deadline:=least(deadline,h.created_at+interval '120 seconds');
  IF h.request->>'checkpointId' IS NULL THEN RETURN deadline;END IF;
  SELECT a.* INTO cp FROM finnor_os.p3_artifacts a
   WHERE a.id=(h.request->>'checkpointId')::uuid AND a.tenant_id=p_tenant AND a.principal_id=p_principal
    AND a.work_id=h.work_id AND a.category='CHECKPOINT';
  IF cp.id IS NULL OR cp.body->>'schema'<>'finnor.branch-checkpoint-sealed.v2' THEN
   RAISE EXCEPTION 'P3 sealed checkpoint ancestry required';END IF;
  cursor_id:=(cp.body->'binding'->>'branchId')::uuid;
  IF cursor_id IS NULL THEN RAISE EXCEPTION 'P3 checkpoint parent unavailable';END IF;
 END LOOP;
 RAISE EXCEPTION 'P3 episode ancestry bound';
END $$;
CREATE FUNCTION finnor_os.p3_episode_deadline_guard() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,finnor_os AS $$
DECLARE deadline timestamptz;cp finnor_os.p3_artifacts;
BEGIN
 IF TG_OP='INSERT' AND NEW.request->>'checkpointId' IS NOT NULL THEN
  SELECT * INTO cp FROM finnor_os.p3_artifacts
   WHERE id=(NEW.request->>'checkpointId')::uuid AND tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id
    AND work_id=NEW.work_id AND category='CHECKPOINT';
  IF cp.id IS NULL OR cp.body->>'schema'<>'finnor.branch-checkpoint-sealed.v2' THEN
   RAISE EXCEPTION 'P3 sealed checkpoint ancestry required';END IF;
  deadline:=finnor_os.p3_episode_deadline(NEW.tenant_id,NEW.principal_id,(cp.body->'binding'->>'branchId')::uuid);
 ELSIF TG_OP='UPDATE' AND (NEW.result_id IS DISTINCT FROM OLD.result_id OR
    (NEW.status='RUNNING' AND OLD.status<>'RUNNING')) THEN
  deadline:=finnor_os.p3_episode_deadline(NEW.tenant_id,NEW.principal_id,NEW.id);
 END IF;
 IF deadline IS NOT NULL AND deadline<=clock_timestamp() THEN
  RAISE EXCEPTION 'P3 original accepted episode deadline exhausted';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER p3_episode_deadline BEFORE INSERT OR UPDATE ON finnor_os.p3_requests
 FOR EACH ROW EXECUTE FUNCTION finnor_os.p3_episode_deadline_guard();
GRANT EXECUTE ON FUNCTION finnor_os.p3_episode_deadline(uuid,uuid,uuid) TO finnor_app;
