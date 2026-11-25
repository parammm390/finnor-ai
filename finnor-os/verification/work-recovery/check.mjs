#!/usr/bin/env node
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const TLA2TOOLS = {
  version: "1.7.4",
  url: "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
  sha256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
}
const CASES = [
  { variant: "current", expect: null, means: "the code at this commit" },
  { variant: "before_planner_fence", expect: "SinglePlanner", means: "main before the planner fence: a stalled claim plans next to its takeover" },
  { variant: "pre_082260a2", expect: "SinglePlanner", means: "the unlocked status read that 082260a2 replaced with a leased claim" },
  { variant: "pre_17034c60", expect: "OwnerOnly", means: "the claim without the owner check that 17034c60 added" },
  { variant: "unlocked_owner_check", expect: "OwnerOnly", means: "an owner check moved out of the locked claim into the route" },
]

const sha256 = path => createHash("sha256").update(readFileSync(path)).digest("hex")

async function tla2tools() {
  const jar = process.env.TLA2TOOLS_JAR ?? join(tmpdir(), `finnor-tla2tools-${TLA2TOOLS.version}.jar`)
  if (!existsSync(jar)) {
    const response = await fetch(TLA2TOOLS.url, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`Cannot download tla2tools ${TLA2TOOLS.version}: HTTP ${response.status}`)
    writeFileSync(jar, Buffer.from(await response.arrayBuffer()))
  }
  if (sha256(jar) !== TLA2TOOLS.sha256) throw new Error(`${jar} is not tla2tools ${TLA2TOOLS.version} (sha256 mismatch)`)
  return jar
}

function check(jar, variant) {
  const metadir = mkdtempSync(join(tmpdir(), `tlc-${variant}-`))
  try {
    const run = spawnSync(process.env.JAVA ?? "java", ["-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC", "-workers", "1", "-deadlock",
      "-metadir", metadir, "-config", `${variant}.cfg`, "WorkRecovery.tla"], { cwd: here, encoding: "utf8", maxBuffer: 64 << 20 })
    const output = `${run.stdout}${run.stderr}`
    const violated = /Invariant (\w+) is violated/.exec(output)?.[1] ?? null
    const passed = output.includes("Model checking completed. No error has been found.")
    const states = /(\d+) distinct states found/.exec(output)?.[1] ?? "?"
    const steps = [...output.matchAll(/^State \d+: <(\w+)/gm)].map(match => match[1])
    return { output, violated, passed, states, steps }
  } finally {
    rmSync(metadir, { recursive: true, force: true })
  }
}

const jar = await tla2tools()
let failed = false
for (const { variant, expect, means } of CASES) {
  const result = check(jar, variant)
  const matches = expect === null ? result.passed : result.violated === expect
  if (!matches) failed = true
  const outcome = result.passed ? "no invariant violated" : result.violated ? `${result.violated} violated` : "TLC did not finish"
  console.log(`${matches ? "ok  " : "FAIL"} ${variant}: ${outcome} (${result.states} states). ${means}.`)
  if (result.violated) console.log(`     counterexample: ${result.steps.join(" -> ")}`)
  if (!matches) console.log(result.output.split("\n").slice(-40).join("\n"))
}
if (failed) {
  console.error("The model no longer matches the code or a property broke. Read the counterexample with /statechart, then see .devin/skills/verify-work-recovery/SKILL.md.")
  process.exit(1)
}
