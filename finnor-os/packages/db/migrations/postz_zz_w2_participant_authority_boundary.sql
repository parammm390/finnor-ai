-- Recipient identities use explicit workforce bindings, never legacy employee
-- authority roles. The historical sync trigger assumed every users.role had a
-- legacy role row, so participant inserts and owner demotions otherwise failed.
CREATE OR REPLACE FUNCTION finnor_os.sync_user_legacy_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE selected_role uuid;
BEGIN
  IF NEW.role='participant' THEN
    UPDATE finnor_os.employee_role_assignments
      SET active=false
      WHERE tenant_id=NEW.tenant_id AND employee_id=NEW.id AND active;
    RETURN NEW;
  END IF;
  PERFORM finnor_os.ensure_legacy_authority(NEW.tenant_id);
  SELECT id INTO selected_role FROM finnor_os.employee_roles
    WHERE tenant_id=NEW.tenant_id AND legacy_role=NEW.role;
  IF selected_role IS NULL THEN
    RAISE EXCEPTION 'No legacy authority role for employee role %', NEW.role;
  END IF;
  UPDATE finnor_os.employee_role_assignments a SET active=false
    FROM finnor_os.employee_roles r
    WHERE a.employee_id=NEW.id AND a.tenant_id=NEW.tenant_id
      AND a.role_id=r.id AND r.legacy_role IS NOT NULL AND r.id<>selected_role;
  INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope,active)
    VALUES (NEW.tenant_id,NEW.id,selected_role,'{"kind":"tenant"}'::jsonb,true)
    ON CONFLICT (employee_id,role_id) DO UPDATE SET active=true,expires_at=NULL;
  RETURN NEW;
END $$;

-- Repair previously provisioned participants without issuing any new grant.
UPDATE finnor_os.employee_role_assignments a SET active=false
  FROM finnor_os.users u
  WHERE a.tenant_id=u.tenant_id AND a.employee_id=u.id
    AND u.role='participant' AND a.active;
