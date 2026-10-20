-- Full declared X1 population has 128 frozen duties. Its typed native binding
-- is bounded by the already supported 8 MiB P1 head capacity, not the small
-- analytical request domain. Legacy limits remain exact.
ALTER TABLE finnor_os.p1_requests DROP CONSTRAINT p1_requests_request_check;
ALTER TABLE finnor_os.p1_requests ADD CONSTRAINT p1_requests_request_check
 CHECK(octet_length(request::text)<=CASE WHEN request->>'kind' IS NOT DISTINCT FROM 'institution_responsibility_v1'
   THEN 8388608 ELSE 65536 END);
ALTER TABLE finnor_os.p1_requests DROP CONSTRAINT p1_requests_proposed_check;
ALTER TABLE finnor_os.p1_requests ADD CONSTRAINT p1_requests_proposed_check
 CHECK(octet_length(proposed::text)<=CASE WHEN request->>'kind' IS NOT DISTINCT FROM 'institution_responsibility_v1'
   AND proposed->>'schema' IS NOT DISTINCT FROM 'finnor.institution-harness-program.v1'
   THEN 8388608 ELSE 1048576 END);
