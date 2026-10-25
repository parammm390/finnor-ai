# Standalone source-only catalogue validation

This run repairs the retained omitted-production-route failure. It uses the
existing `/tmp/z3-cat-gen` disposable source copy and openly borrowed root
and backend dependencies. It is not an independently installed target.
The generator carries only this lane's Z3 corrections; the combined
coordinator generator already includes equivalent Z3 semantics and must not
be overwritten. No database, Auth, listener, application build or effect runs.
The real generator and coverage audit are regenerated and checked, unchanged.
