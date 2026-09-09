-- P3 external artifact effects use the existing Employee Authority runtime.
-- Existing custom roles remain untouched; the canonical owner role receives the
-- two bounded document capabilities needed for provider publication/calculation.
CREATE OR REPLACE FUNCTION finnor_os.sync_artifact_owner_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF NEW.legacy_role='owner' THEN
    INSERT INTO finnor_os.role_authority_grants(
      tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required
    ) VALUES
      (NEW.tenant_id,NEW.id,'artifact:publish','document','allow','medium',false),
      (NEW.tenant_id,NEW.id,'artifact:recalculate','document','allow','medium',false)
    ON CONFLICT(role_id,capability,resource_type) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS employee_roles_artifact_owner_authority ON finnor_os.employee_roles;
CREATE TRIGGER employee_roles_artifact_owner_authority
  AFTER INSERT OR UPDATE OF legacy_role ON finnor_os.employee_roles
  FOR EACH ROW EXECUTE FUNCTION finnor_os.sync_artifact_owner_authority();

INSERT INTO finnor_os.role_authority_grants(
  tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required
)
SELECT tenant_id,id,capability,'document','allow','medium',false
FROM finnor_os.employee_roles
CROSS JOIN (VALUES('artifact:publish'),('artifact:recalculate')) AS artifact_capability(capability)
WHERE legacy_role='owner'
ON CONFLICT(role_id,capability,resource_type) DO NOTHING;
