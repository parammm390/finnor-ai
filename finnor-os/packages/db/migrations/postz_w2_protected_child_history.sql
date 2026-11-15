-- A repeated refused request observes a new time-bound canonical cut. Keep
-- each exact content-addressed refusal; never overwrite the first cut or turn
-- its different timestamp into a hidden identity-conflict failure. Identical
-- content is still idempotent, and the existing immutability/RLS/FKs remain.
ALTER TABLE finnor_os.w2_protected_child_bindings
 DROP CONSTRAINT w2_protected_child_bindings_pkey;
ALTER TABLE finnor_os.w2_protected_child_bindings
 ADD PRIMARY KEY(tenant_id,program_id,assignment_id,effect_key,refusal_digest);
