# Original process integrity failure, retained

`process-e2e-01/report.json`, actual exit **1**, ran the pre-code process
contract against real Node and isolated Python processes. 39/41 checks passed.
Two corruptions were incorrectly accepted: an invented whole-code
correspondence statement and a false original-counterexample class.

Original checker SHA-256:
`1d19df99313938766754ac2b8825cc23b426d84bfd773c61d172a94c1443632e`.
Original producer SHA-256:
`d663a2505f06c338922a1018c7026152fd74ee392eb3a903c19bf7346b9b4de5`.
Original process/tool log:
`/home/factory-user/.factory/artifacts/scripts/08db35bb-8bc7-480d-be0b-f5570f53c841/call_oqSuXQEdfI1zH5Gb6S53jW4s.log`.
The full corrupt inputs' digests, stdout, stderr and physical exits remain in
that immutable run directory. No frozen mathematical fixture changed.

Root correction: independently require the exact certificate field set and
the bounded-kernel correspondence statement; classify the trace's actual
final state independently as its original fault, safety/assumption failure,
or nonblocking failure. No producer or expected-value change is needed.

Both previously accepted corruptions are rerun, with the rest of the fixed
process contract for regression. The correspondence guard applies to every
certificate, so **all 256 frozen certificates are affected** and a full
unchanged-input affected rerun is justified. Earlier public-sweep-02 is a
historical pass under the weaker checker, not current-source qualification.
