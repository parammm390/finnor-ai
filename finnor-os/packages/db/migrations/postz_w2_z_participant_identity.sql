-- A recipient-only product identity; no grant or existing identity is changed.
ALTER TABLE finnor_os.users DROP CONSTRAINT users_role_check;
ALTER TABLE finnor_os.users ADD CONSTRAINT users_role_check
 CHECK(role IN ('owner','participant','dispatcher','technician'));
