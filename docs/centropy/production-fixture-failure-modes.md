# Compiled local certification fixture

Failure modes recorded before adding the compiled-server mode: running a development server and labeling its timing production performance; pointing test writes at a remote database; reusing dev Auth bypass; sending real email through fixture credentials; compiling frontend and API against different Auth projects; using stale compiled files; or claiming that a local compiled build certifies the live deployment.

The existing persistent localhost harness may run `next start` for the frontend and API after both builds pass. Database access remains pinned to its named loopback fixture. Auth bypass is unset. The compiled API's explicit plaintext-secret override is restricted to this local harness and is reported in the evidence; it is never a release environment configuration. Worker runtime remains the actual canonical worker. Local production-build measurements do not certify the deployed host or cloud networking.
