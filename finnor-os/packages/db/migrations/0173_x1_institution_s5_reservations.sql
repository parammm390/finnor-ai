-- Institution demand is a typed S5 resource occupant, not an X1 budget.
-- All mutations use the S5 tenant-wide portfolio serializer and its current
-- resource registry. Old finite certificates retain their original grammar.
CREATE TABLE finnor_os.s5_institution_reservations (
  tenant_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  work_id uuid NOT NULL,
  reservation_id text NOT NULL,
  demand_digest text NOT NULL CHECK (demand_digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  rights_revision text NOT NULL,
  deadline_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED','CONSUMPTION_PENDING','UNKNOWN_OUTCOME','RELEASED')),
  body jsonb NOT NULL CHECK (octet_length(body::text)<=262144),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,reservation_id),
  UNIQUE (tenant_id,principal_id,reservation_id),
  UNIQUE (tenant_id,principal_id,work_id,demand_digest),
  FOREIGN KEY (tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
  FOREIGN KEY (tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id)
);
CREATE TABLE finnor_os.s5_institution_charges (
  tenant_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  reservation_id text NOT NULL,
  charge_key text NOT NULL,
  request_digest text NOT NULL,
  resource_id text NOT NULL,
  unit text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('EXECUTION','RECOVERY','HUMAN')),
  units integer NOT NULL CHECK (units BETWEEN 1 AND 100000),
  body jsonb NOT NULL CHECK (octet_length(body::text)<=65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,reservation_id,charge_key),
  FOREIGN KEY (tenant_id,principal_id,reservation_id)
    REFERENCES finnor_os.s5_institution_reservations(tenant_id,principal_id,reservation_id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['s5_institution_reservations','s5_institution_charges'] LOOP
    EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY s5_institution_owner ON finnor_os.%I USING (tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK (tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON finnor_os.%I TO finnor_app',t);
  END LOOP;
END $$;
