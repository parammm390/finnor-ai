#!/usr/bin/env node
// Coordinator-owned Z4 replay-grant signer wrapper (not part of any worker's ownership).
// usage: node z4-sign-grant.mjs --repository <abs checkout> --scope <abs scope.json> --out-dir <abs dir>
// It runs the policy implementation with the checkout's own tsx so the checkout's schemas are used verbatim.
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  ?? (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined)
const repository = arg("repository")
if (!repository || !repository.startsWith("/")) { console.error("Z4_SIGNER_REPOSITORY_REQUIRED"); process.exit(64) }
const tsx = join(repository, "finnor-os/node_modules/.bin/tsx")
if (!existsSync(tsx)) { console.error("Z4_SIGNER_TSX_MISSING"); process.exit(65) }
const run = spawnSync(tsx, [join(here, "z4-sign-grant.impl.mts"), ...process.argv.slice(2)],
  { cwd: join(repository, "finnor-os"), stdio: "inherit", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" } })
process.exit(run.status ?? 70)
