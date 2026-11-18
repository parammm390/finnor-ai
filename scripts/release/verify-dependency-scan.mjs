import { readFileSync, writeFileSync } from "node:fs"
import { relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

const rustLock = "finnor-os/packages/epistemic-runtime/native/z4-execution-proof/Cargo.lock"
const maintenance = new Map([
  ["RUSTSEC-2025-0141", ["bincode", "2.0.1"]],
  ["RUSTSEC-2026-0543", ["chrono", "0.4.45"]],
  ["RUSTSEC-2024-0436", ["paste", "1.0.15"]],
])

function isReviewedMaintenance(source, pkg, advisory) {
  const reviewed = maintenance.get(advisory.id)
  if (!reviewed || source.type !== "lockfile" || resolve(source.path) !== resolve(rustLock)
    || pkg.ecosystem !== "crates.io" || pkg.name !== reviewed[0] || pkg.version !== reviewed[1]
    || advisory.aliases?.length || advisory.related?.length || advisory.severity?.length
    || advisory.database_specific?.severity) return false
  return Array.isArray(advisory.affected) && advisory.affected.length === 1 && advisory.affected.every(record =>
    record.package?.ecosystem === pkg.ecosystem && record.package.name === pkg.name
    && record.database_specific?.source === `https://github.com/rustsec/advisory-db/blob/osv/crates/${advisory.id}.json`
    && record.database_specific.informational === "unmaintained"
    && !record.database_specific.cvss && !record.database_specific.severity && !record.severity?.length)
}

export function evaluateDependencyScan(report, scannerStatus) {
  if (!["0", "1"].includes(scannerStatus) || !Array.isArray(report?.results))
    throw Error("Missing or invalid OSV result")
  const warnings = [], failures = []
  for (const { source, packages } of report.results) {
    if (typeof source?.path !== "string" || !Array.isArray(packages))
      throw Error("Invalid OSV source")
    for (const { package: pkg, vulnerabilities } of packages) {
      if (typeof pkg?.name !== "string" || typeof pkg.version !== "string" || !vulnerabilities?.length || !Array.isArray(vulnerabilities))
        throw Error("Invalid OSV package result")
      for (const advisory of vulnerabilities) {
        if (!advisory?.id || !/^[A-Za-z0-9_.-]+$/.test(advisory.id)) throw Error("Invalid OSV advisory identity")
        const message = `${advisory.id} ${JSON.stringify(pkg.name)} ${JSON.stringify(pkg.version)}`
        if (isReviewedMaintenance(source, pkg, advisory)) warnings.push(message)
        else failures.push(message)
      }
    }
  }
  if ((scannerStatus === "1") !== (warnings.length + failures.length > 0))
    throw Error("OSV exit status and findings disagree")
  return { warnings, failures }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = JSON.parse(readFileSync(process.argv[2], "utf8"))
    const { warnings, failures } = evaluateDependencyScan(report, process.env.OSV_SCANNER_STATUS)
    if (process.argv[3]) {
      // The SARIF renderer runs in a Docker checkout at a different mount path.
      for (const { source } of report.results) {
        const path = relative(process.cwd(), resolve(source.path))
        if (!path || path === ".." || path.startsWith(".." + sep))
          throw Error("OSV source is outside the checkout")
        source.path = path
      }
      writeFileSync(process.argv[3], JSON.stringify(report))
    }
    for (const message of warnings) console.log(`::warning::RustSec maintenance notice ${message}`)
    for (const message of failures) console.error(`::error::Dependency advisory ${message}`)
    console.log(`OSV retained ${warnings.length} maintenance notices and ${failures.length} blocking advisories.`)
    if (failures.length) process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : "OSV report could not be verified")
    process.exitCode = 1
  }
}
