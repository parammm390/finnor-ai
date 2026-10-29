CREATE TABLE finnor_os.employee_conversation_checkpoints (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 owner_employee_id uuid NOT NULL,
 thread_id uuid NOT NULL,
 parent_id uuid,
 from_sequence integer NOT NULL,
 through_sequence integer NOT NULL,
 source_digest text NOT NULL,
 state jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT conversation_checkpoints_sequence_check CHECK(from_sequence>0 AND through_sequence>=from_sequence),
 CONSTRAINT conversation_checkpoints_digest_check CHECK(source_digest ~ '^[a-f0-9]{64}$'),
 CONSTRAINT conversation_checkpoints_state_check CHECK(jsonb_typeof(state)='object' AND octet_length(state::text)<=2097152),
 CONSTRAINT conversation_checkpoints_scope_key UNIQUE(tenant_id,id,owner_employee_id,thread_id),
 CONSTRAINT conversation_checkpoints_cut_key UNIQUE(tenant_id,owner_employee_id,thread_id,through_sequence),
 CONSTRAINT conversation_checkpoints_thread_fkey FOREIGN KEY(tenant_id,thread_id,owner_employee_id)
   REFERENCES finnor_os.employee_conversation_threads(tenant_id,id,owner_employee_id) ON DELETE CASCADE,
 CONSTRAINT conversation_checkpoints_parent_fkey FOREIGN KEY(tenant_id,parent_id,owner_employee_id,thread_id)
   REFERENCES finnor_os.employee_conversation_checkpoints(tenant_id,id,owner_employee_id,thread_id)
);
CREATE INDEX employee_conversation_checkpoints_cut
 ON finnor_os.employee_conversation_checkpoints(tenant_id,owner_employee_id,thread_id,through_sequence DESC);
ALTER TABLE finnor_os.employee_conversation_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.employee_conversation_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_self_only ON finnor_os.employee_conversation_checkpoints
 USING(tenant_id=finnor_os.request_tenant_id() AND owner_employee_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND owner_employee_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE FUNCTION finnor_os.conversation_checkpoint_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Conversation checkpoints are immutable'; END $$;
CREATE TRIGGER conversation_checkpoint_immutable BEFORE UPDATE ON finnor_os.employee_conversation_checkpoints
 FOR EACH ROW EXECUTE FUNCTION finnor_os.conversation_checkpoint_immutable();

-- The native source message is the accepted input's immutable chat binding.
CREATE UNIQUE INDEX employee_conversation_user_work_input
 ON finnor_os.employee_conversation_messages(work_input_id)
 WHERE role='user' AND work_input_id IS NOT NULL;
CREATE FUNCTION finnor_os.conversation_source_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE accepted finnor_os.work_inputs%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.id,NEW.tenant_id,NEW.owner_employee_id,NEW.thread_id,NEW.sequence,NEW.role,NEW.original_text,NEW.instruction_id,NEW.created_at)
   IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.owner_employee_id,OLD.thread_id,OLD.sequence,OLD.role,OLD.original_text,OLD.instruction_id,OLD.created_at)
 THEN RAISE EXCEPTION 'Conversation source identity is immutable'; END IF;
 IF TG_OP='UPDATE' AND ((OLD.work_input_id IS NOT NULL AND NEW.work_input_id IS DISTINCT FROM OLD.work_input_id)
   OR (OLD.work_id IS NOT NULL AND NEW.work_id IS DISTINCT FROM OLD.work_id))
 THEN RAISE EXCEPTION 'Conversation Work binding is immutable'; END IF;
 IF NEW.role='user' AND NEW.work_input_id IS NOT NULL THEN
   SELECT * INTO accepted FROM finnor_os.work_inputs
    WHERE tenant_id=NEW.tenant_id AND id=NEW.work_input_id;
   IF NOT FOUND OR accepted.work_id IS DISTINCT FROM NEW.work_id
    OR accepted.created_by IS DISTINCT FROM NEW.owner_employee_id
    OR accepted.instruction_id IS DISTINCT FROM NEW.instruction_id
    OR accepted.instruction_text IS DISTINCT FROM NEW.original_text
   THEN RAISE EXCEPTION 'Conversation must bind the exact accepted human Work input'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER conversation_source_identity_guard BEFORE INSERT OR UPDATE
 ON finnor_os.employee_conversation_messages FOR EACH ROW EXECUTE FUNCTION finnor_os.conversation_source_identity_guard();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
  GRANT SELECT,INSERT ON finnor_os.employee_conversation_checkpoints TO finnor_app;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_worker') THEN
  GRANT SELECT,INSERT ON finnor_os.employee_conversation_checkpoints TO finnor_worker;
 END IF;
END $$;

INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('compact_employee_conversation_v1','BACKGROUND',ARRAY['BACKGROUND'],'fixed','tenant','required',1,'Private source-checked conversation compaction; no effects') ON CONFLICT(job_type) DO NOTHING;
