-- Participant identity does not create a legacy role or inherit its grants.
CREATE OR REPLACE FUNCTION finnor_os.sync_user_legacy_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE selected_role uuid;
BEGIN
  IF NEW.role='participant' THEN
    INSERT INTO finnor_os.authority_states(tenant_id) VALUES (NEW.tenant_id)
      ON CONFLICT DO NOTHING;
  ELSE
    PERFORM finnor_os.ensure_legacy_authority(NEW.tenant_id);
    SELECT id INTO selected_role FROM finnor_os.employee_roles
      WHERE tenant_id=NEW.tenant_id AND legacy_role=NEW.role;
    IF selected_role IS NULL THEN
      RAISE EXCEPTION 'legacy authority role unavailable';
    END IF;
  END IF;

  UPDATE finnor_os.employee_role_assignments a SET active=false
    FROM finnor_os.employee_roles r
    WHERE a.tenant_id=NEW.tenant_id AND a.employee_id=NEW.id AND a.active
      AND r.tenant_id=NEW.tenant_id AND a.role_id=r.id
      AND r.legacy_role IS NOT NULL AND r.id IS DISTINCT FROM selected_role;
  IF selected_role IS NOT NULL THEN
    INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope,active)
      VALUES (NEW.tenant_id,NEW.id,selected_role,'{"kind":"tenant"}'::jsonb,true)
      ON CONFLICT (employee_id,role_id) DO UPDATE SET active=true,expires_at=NULL;
  END IF;
  RETURN NEW;
END $$;
