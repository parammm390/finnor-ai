import { installVerticalFixtureSeam } from "../tests/vertical-fixture-seam";

installVerticalFixtureSeam().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
