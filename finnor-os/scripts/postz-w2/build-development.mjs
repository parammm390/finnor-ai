// Reuse the actual source-custody/dependency packager with a distinct W2
// manifest, worker entry, checker and registered finite build profile.
if (process.argv.length !== 4 || process.argv[2] !== "--output")
  throw Error("W2_BUILD_REQUIRES_NEW_ABSOLUTE_OUTPUT");
process.argv.push("--profile", "postz-w2");
await import("../frontier5/x1/build-development.mjs");
