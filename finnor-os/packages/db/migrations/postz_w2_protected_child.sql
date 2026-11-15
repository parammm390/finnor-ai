-- A possible protected delegated child is refused before child creation and
-- before any new S5 consumption. This append-only binding preserves the exact
-- checked owner inputs: current parent chain, recipient attenuation, original
-- root budget, attempt history and the concrete S6 origin/consumption join.
-- Nullable owner columns stay NULL when no canonical S6 origin exists; the
-- foreign keys make any claimed origin the real row, never a caller string.
-- No row here admits protected custody, egress or execution authority.
CREATE TABLE finnor_os.w2_protected_child_bindings(
 tenant_id uuid NOT NULL, program_id uuid NOT NULL, assignment_id text NOT NULL,
 effect_key text NOT NULL, principal_id uuid NOT NULL, parent_assignment_id text NULL,
 effect_id uuid NULL, domain_action_id uuid NULL, consumption_id text NULL,
 refusal_digest text NOT NULL CHECK(refusal_digest ~ '^[a-f0-9]{64}$'),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=262144),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,program_id,assignment_id,effect_key),
 FOREIGN KEY(tenant_id,program_id) REFERENCES finnor_os.w2_programs(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,effect_id) REFERENCES finnor_os.business_effects(tenant_id,id),
 FOREIGN KEY(tenant_id,domain_action_id) REFERENCES finnor_os.domain_actions(tenant_id,id),
 FOREIGN KEY(tenant_id,consumption_id) REFERENCES finnor_os.s5_consumptions(tenant_id,consumption_id)
);
CREATE TRIGGER w2_protected_child_immutable BEFORE UPDATE OR DELETE ON finnor_os.w2_protected_child_bindings
 FOR EACH ROW EXECUTE FUNCTION finnor_os.w2_immutable();
ALTER TABLE finnor_os.w2_protected_child_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.w2_protected_child_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY w2_protected_child_owner ON finnor_os.w2_protected_child_bindings USING(
 tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
DO $$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['finnor_app','finnor_worker'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('GRANT SELECT,INSERT ON finnor_os.w2_protected_child_bindings TO %I',role_name);
  END IF;
 END LOOP;
END $$;
