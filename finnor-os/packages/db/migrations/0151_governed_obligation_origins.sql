-- S6 immutable responsibility joins native effect and S5 resource owners.
-- Ordinary SQL/RLS provides durability, not hostile-caller authentication or Ring-0 admission.
CREATE TABLE finnor_os.s6_obligation_origins (
 tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id), principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 obligation_id text NOT NULL, consumption_id text NOT NULL, effect_id uuid NOT NULL, domain_action_id uuid NOT NULL,
 input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'), body jsonb NOT NULL CHECK(octet_length(body::text)<=8388608),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,obligation_id),
 UNIQUE(tenant_id,consumption_id), UNIQUE(tenant_id,effect_id), UNIQUE(tenant_id,domain_action_id),
 FOREIGN KEY(tenant_id,consumption_id) REFERENCES finnor_os.s5_consumptions(tenant_id,consumption_id),
 FOREIGN KEY(tenant_id,effect_id) REFERENCES finnor_os.business_effects(tenant_id,id),
 FOREIGN KEY(tenant_id,domain_action_id) REFERENCES finnor_os.domain_actions(tenant_id,id)
);
CREATE FUNCTION finnor_os.s6_immutable_origin() RETURNS trigger LANGUAGE plpgsql SET search_path=finnor_os,pg_temp AS $$
BEGIN RAISE EXCEPTION 'S6 obligation origins are append-only'; END $$;
CREATE TRIGGER s6_origin_immutable BEFORE UPDATE OR DELETE ON finnor_os.s6_obligation_origins FOR EACH ROW EXECUTE FUNCTION finnor_os.s6_immutable_origin();
ALTER TABLE finnor_os.s6_obligation_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.s6_obligation_origins FORCE ROW LEVEL SECURITY;
CREATE POLICY s6_obligation_tenant ON finnor_os.s6_obligation_origins USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN GRANT SELECT,INSERT,UPDATE ON finnor_os.s6_obligation_origins TO finnor_app; END IF; END $$;
