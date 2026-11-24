#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"

const FIX = "Derive it from the file's own location (import.meta.url, __file__), the working directory or an environment variable, and record evidence paths relative to the repository root."
const MACHINE_PATH = /(?:\/Users\/|\/home\/)[^/\s"'`]+\/|[A-Za-z]:\\\\?Users\\\\?[^\\\s"'`]+|\/private\/var\/folders\/|\/var\/folders\/[^/\s]+\//
const EXCEPTION = /allow-machine-path: .+; expires=(\d{4}-\d{2}-\d{2}); approved=@[\w-]+/

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`)
  return result.stdout
}

export function addedLines(base, head) {
  const lines = []
  let file = null
  let next = 0
  for (const line of git(["diff", "--no-color", "--no-ext-diff", "--unified=0", "--find-renames", "--diff-filter=ACMR", base, head]).split("\n")) {
    if (line.startsWith("+++ ")) file = line === "+++ /dev/null" ? null : line.slice(6)
    else if (line.startsWith("@@")) next = Number(/\+(\d+)/.exec(line)[1])
    else if (line.startsWith("+") && file) lines.push({ file, line: next++, text: line.slice(1) })
  }
  return lines
}

export function machineLocalPaths(lines, today = new Date().toISOString().slice(0, 10)) {
  return lines.flatMap(({ file, line, text }) => {
    const match = MACHINE_PATH.exec(text)
    if (!match) return []
    const exception = EXCEPTION.exec(text)
    if (exception && exception[1] >= today) return []
    const reason = exception ? `exception expired on ${exception[1]}` : FIX
    return [`${file}:${line}: machine-local path "${match[0]}". ${reason}`]
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.argv[2] ?? git(["merge-base", "origin/main", "HEAD"]).trim()
  const head = process.argv[3] ?? "HEAD"
  const failures = machineLocalPaths(addedLines(base, head))
  for (const failure of failures) console.error(failure)
  if (failures.length) process.exit(1)
  console.log(`No machine-local paths added between ${base.slice(0, 12)} and ${head}.`)
}
