import { installVerticalFixtureSeam } from "../tests/vertical-fixture-seam";
import { assertDisposableDatabaseTarget } from "../packages/db/production-target-guard";

assertDisposableDatabaseTarget(process.env.DATABASE_URL, "legacy fixture seam");
installVerticalFixtureSeam().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
