-- Additive correction for inherited future-table privileges. Preserve 0191 and
-- every original possible request, including denied/unknown/cancelled work.
REVOKE DELETE ON finnor_os.application_semantics_requests FROM finnor_app, finnor_worker;

CREATE OR REPLACE FUNCTION finnor_os.reject_application_semantics_request_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, finnor_os
AS $$
BEGIN
  RAISE EXCEPTION 'Original application requests are durable effect custody'
    USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER application_semantics_request_delete_guard
BEFORE DELETE ON finnor_os.application_semantics_requests
FOR EACH ROW EXECUTE FUNCTION finnor_os.reject_application_semantics_request_delete();
