# Public sweep 01, retained failure

Actual exit 1; 256 original cases launched; all producer exits 1, no semantic
checker ran. Source identities and all subprocess stderr remain in
`public-sweep-01/`. Node 22 strip-only mode rejects TypeScript constructor
parameter properties. This is an implementation/runtime packaging defect,
not a fixture/oracle failure or missing native authority.

Correction: explicit class fields and constructor assignments, preserving
the pinned Node runtime. All cases are affected by this syntax correction;
the diagnosed full rerun uses the unchanged frozen inputs and expectations.
The failed run is not overwritten or counted as useful positives.
