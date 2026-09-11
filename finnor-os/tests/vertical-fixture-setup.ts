// Integration compatibility fixture for generic pre-vertical Core tests.
//
// Phase 5 deliberately removed the production default-vertical tenant trigger:
// a new production tenant must choose a product explicitly.  The older Core
// integration fixtures predate that contract and create generic tenants without
// an assignment, so the disposable test database assigns the Core `none`
// vertical unless a fixture explicitly declares that it owns vertical setup.
// Install this seam only in the disposable CI/test database. PE certification
// fixtures opt out with `SET app.test_vertical_mode = 'explicit'` and therefore
// continue to prove the missing-assignment boundary.

import { installVerticalFixtureSeam } from "./vertical-fixture-seam";

// Unit/planner runs can start before the integration schema exists. The explicit
// CI step installs the same seam again after db:migrate on a fresh database.
try {
  await installVerticalFixtureSeam();
} catch {
  // The integration job installs the seam after migrations; pre-migration setup
  // must remain harmless for unit/planner runs.
}
