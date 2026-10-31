-- W2 owned canonical outbound compensation payment preparation. Requests are
-- append-only and content-addressed to exactly one accepted S5 obligation;
-- boundary observations record the S6 financial broker boundary's durable
-- admission decision (always UNADMITTED while no qualified outbound
-- settlement provider is installed). Neither table can authorize a financial
-- transfer, and neither ever rewrites the accepted obligation history.
CREATE TABLE finnor_os.s5_workforce_payment_requests(
 tenant_id uuid NOT NULL,request_id text NOT NULL,programme_id uuid NOT NULL,
 obligation_digest text NOT NULL CHECK(obligation_digest ~ '^[a-f0-9]{64}$'),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,request_id),UNIQUE(tenant_id,obligation_digest)
);
CREATE TABLE finnor_os.s5_workforce_payment_observations(
 tenant_id uuid NOT NULL,observation_id text NOT NULL,request_id text NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,observation_id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.s5_workforce_payment_requests(tenant_id,request_id)
);
ALTER TABLE finnor_os.s5_workforce_payment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.s5_workforce_payment_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.s5_workforce_payment_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.s5_workforce_payment_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY w2_payment_request_owner ON finnor_os.s5_workforce_payment_requests USING(
 tenant_id=finnor_os.request_tenant_id() AND EXISTS(SELECT 1 FROM finnor_os.w2_programs p
 WHERE p.tenant_id=s5_workforce_payment_requests.tenant_id AND p.id=s5_workforce_payment_requests.programme_id
 AND p.principal_id=nullif(current_setting('app.user_id',true),'')::uuid))
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND EXISTS(SELECT 1 FROM finnor_os.w2_programs p
 WHERE p.tenant_id=s5_workforce_payment_requests.tenant_id AND p.id=s5_workforce_payment_requests.programme_id
 AND p.principal_id=nullif(current_setting('app.user_id',true),'')::uuid));
CREATE POLICY w2_payment_observation_owner ON finnor_os.s5_workforce_payment_observations USING(
 tenant_id=finnor_os.request_tenant_id() AND EXISTS(SELECT 1 FROM finnor_os.s5_workforce_payment_requests r
 JOIN finnor_os.w2_programs p ON p.tenant_id=r.tenant_id AND p.id=r.programme_id
 WHERE r.tenant_id=s5_workforce_payment_observations.tenant_id AND r.request_id=s5_workforce_payment_observations.request_id
 AND p.principal_id=nullif(current_setting('app.user_id',true),'')::uuid))
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND EXISTS(SELECT 1 FROM finnor_os.s5_workforce_payment_requests r
 JOIN finnor_os.w2_programs p ON p.tenant_id=r.tenant_id AND p.id=r.programme_id
 WHERE r.tenant_id=s5_workforce_payment_observations.tenant_id AND r.request_id=s5_workforce_payment_observations.request_id
 AND p.principal_id=nullif(current_setting('app.user_id',true),'')::uuid));
CREATE TRIGGER w2_payment_request_immutable BEFORE UPDATE OR DELETE ON finnor_os.s5_workforce_payment_requests
 FOR EACH ROW EXECUTE FUNCTION finnor_os.w2_immutable();
CREATE TRIGGER w2_payment_observation_immutable BEFORE UPDATE OR DELETE ON finnor_os.s5_workforce_payment_observations
 FOR EACH ROW EXECUTE FUNCTION finnor_os.w2_immutable();
DO $$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['finnor_app','finnor_worker'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('GRANT SELECT,INSERT ON finnor_os.s5_workforce_payment_requests TO %I',role_name);
   EXECUTE format('GRANT SELECT,INSERT ON finnor_os.s5_workforce_payment_observations TO %I',role_name);
  END IF;
 END LOOP;
END $$;
