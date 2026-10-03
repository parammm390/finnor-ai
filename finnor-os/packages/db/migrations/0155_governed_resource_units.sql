-- S5 owns unit accounting against its existing retained reservation. This is
-- ordinary owner persistence, never protected admission or a second effect ledger.
CREATE TABLE finnor_os.s5_governed_resource_charges (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL,
 reservation_id text NOT NULL, consumption_id text NOT NULL,
 charge_key text NOT NULL CHECK(length(charge_key)<=512),
 phase text NOT NULL CHECK(phase IN ('EXECUTION','RECOVERY','HUMAN')),
 resource_id text NOT NULL, unit text NOT NULL,
 units bigint NOT NULL CHECK(units BETWEEN 1 AND 100000),
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=8388608),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,reservation_id,charge_key),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES finnor_os.s5_reservations(tenant_id,reservation_id),
 FOREIGN KEY(tenant_id,consumption_id) REFERENCES finnor_os.s5_consumptions(tenant_id,consumption_id)
);
CREATE TRIGGER s5_governed_charge_immutable BEFORE UPDATE OR DELETE
 ON finnor_os.s5_governed_resource_charges FOR EACH ROW EXECUTE FUNCTION finnor_os.s6_immutable_origin();
ALTER TABLE finnor_os.s5_governed_resource_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.s5_governed_resource_charges FORCE ROW LEVEL SECURITY;
CREATE POLICY s5_governed_charge_tenant ON finnor_os.s5_governed_resource_charges
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
 GRANT SELECT,INSERT ON finnor_os.s5_governed_resource_charges TO finnor_app;
END IF; END $$;
