/** Fast owning API/DB/queue/compiler cut, not isolated post-code unit tests. */
if (!process.argv.includes("--fast")) process.argv.push("--fast");
await import("./native.mts");
