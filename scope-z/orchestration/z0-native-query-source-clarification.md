# Z0 source clarification before product repair

Cut: the actual source at `7bfdd2d3ab611c90f1355637858824ff1ba67f98`.
Evidence class: source inspection, not authenticated installed E2E.

## A parser-only D1 repair would be wrong

The earlier extracted probe correctly observed that the generic query parser
strips required semantic Work identity for harness/confidential requests.
That observation alone does **not** establish that those native-only queries
should be exposed as new public wire intents.

Additional actual source:

- `finnor-os/packages/shared-types/src/operational-queries.ts:32-44` explicitly
  gives the programme/native dispatcher original Work semantics.
- `finnor-os/tests/integration/production-query-surface.test.ts` and the release
  boundary keep PROGRAM/CONFIDENTIAL intents out of the **public OpenAPI**
  query branches. Preserve that boundary.
- `finnor-os/packages/orchestration/src/plugin-registry.ts` includes native
  query capabilities for internal planning, with exact required references.
  Internal planning availability is not public HTTP exposure.
- `program-synthesis/plan.ts` and the native objective loop bind the original
  Work/input and native query; they do not rely on a new generic HTTP steering
  request.
- `finnor-os/packages/orchestration/src/index.ts:513-580` treats
  `economic_programme_v1` as an observation of the latest existing Work input.
  Other generic query requests call `receiveWork` and append/transition Work.
- The harness and confidential native readers require their persisted
  **original work_input_id**, authenticated current principal and exact Work
  before query accounting.

Therefore, simply preserving `workId` in the parser can reach a path that appends
a new input and makes the native original-input check fail. It can also violate
an intentional public/native distinction. Do not label “now reaches a later
refusal” a fixed positive owner flow.

Resolve the original intended **native observation seam**, preserve the public
OpenAPI exclusion, prove no new steering input/Work completion/invalidation, and
retain native principal/currentness checks. If a particular public refusal is
intentional, classify that refusal as a non-defect and repair the misleading
accessibility contract instead. Any public-surface expansion needs a separately
reviewed explicit contract, not a disguised parser bug fix.

This clarifies the locked PRD's original-identity/native-ownership requirements;
it does not relax a completion gate or authorize a new effect capability.

## D2 must use the actual canonical manifest

The actual `planningCapabilitiesForVertical(createDefaultPluginRegistry(), ...)`
contains actions, native non-model-proposable capabilities, query metadata,
`wait:event` and `check:objective_success`. Preserve each kind, availability,
required references, human-only status and model-proposability.

In particular `execute_economic_right_transition` is an intentionally
non-model-proposable native capability. Its catalogue omission must be repaired
without making it a model tool. Native query metadata belongs to internal
planning; it is not a new HTTP route.

A second lexical list of the six observed omissions is not a canonical
completeness repair. Compare the full canonical runtime set and metadata, with
mutation controls, and make future omissions fail.
