-- Forward repair for installations that already applied an individual peer.
-- Original charge bodies, identities, units, receipts and historical SQL stay
-- unchanged. Non-application institutional phases retain their schema qualifier.
ALTER TABLE finnor_os.s5_governed_resource_charges
 DROP CONSTRAINT s5_governed_resource_charges_phase_check;
ALTER TABLE finnor_os.s5_governed_resource_charges
 ADD CONSTRAINT s5_governed_resource_charges_phase_check CHECK(
  phase IN('EXECUTION','RECOVERY','HUMAN','ACQUISITION','CHECKING','COMPOSITION','OBSERVATION','MAINTENANCE')
  OR (body->>'schema' IS NOT DISTINCT FROM 'finnor.s5.institution-consumption.v1'
   AND phase IN('CHECK','COMPILE','PREPARATION','CONTROL','LIFECYCLE')));
