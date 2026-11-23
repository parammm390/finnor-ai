// Existing Next standalone packaging, pinned to the separate W2 profile.
if (process.argv.length !== 6 || process.argv[2] !== "--output" || process.argv[4] !== "--origin")
  throw Error("W2_FRONTEND_REQUIRES_NEW_ABSOLUTE_OUTPUT_AND_LOOPBACK_ORIGIN");
process.argv.push("--profile", "postz-w2");
await import("../frontier5/x1/build-frontend.mjs");
