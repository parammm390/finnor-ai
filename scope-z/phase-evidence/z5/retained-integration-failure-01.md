# Retained integrated graph failure

`backend-types-03.log`: actual exit 1. The proposed Company Brain route used
an orchestration subpath alias absent from the real tsconfig. The full graph
reported the unresolved module. The checker additionally detected that
`service.ts` changed during the run, so that run is not a current-source pass.

The proposal now uses the exact existing relative package seam. Request 01 and
its failed log remain unchanged. Request 02 and the subsequent graph checks
must validate the corrected frozen postimages. Frontend type check 01 passed,
but its patch identity is request 01, not the corrected request 02.

Original backend type check 01 also remains: 20 diagnostics, including missing
compute-release reasons, implicit observation types, nullable reservation and
the augmented ProcessEnv spawn overload. Backend check 02 passed its earlier
snapshot, before the final native S8 and integration corrections.
