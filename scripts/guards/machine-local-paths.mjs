#!/usr/bin/env node
import { pathToFileURL } from "node:url"
import { addedLines, rangeFromArgs, unexpiredException } from "./added-lines.mjs"

const FIX = "Derive it from the file's own location (import.meta.url, __file__), the working directory or an environment variable, and record evidence paths relative to the repository root."
const MACHINE_PATH = /(?:\/Users\/|\/home\/)[^/\s"'`]+\/|[A-Za-z]:\\\\?Users\\\\?[^\\\s"'`]+|\/private\/var\/folders\/|\/var\/folders\/[^/\s]+\//

export function machineLocalPaths(lines, today) {
  return lines.flatMap(({ file, line, text }) => {
    const match = MACHINE_PATH.exec(text)
    if (!match) return []
    const exception = unexpiredException(text, "allow-machine-path", today)
    if (exception?.live) return []
    return [`${file}:${line}: machine-local path "${match[0]}". ${exception ? `exception expired on ${exception.expires}` : FIX}`]
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { base, head } = rangeFromArgs(process.argv)
  const failures = machineLocalPaths(addedLines(base, head))
  for (const failure of failures) console.error(failure)
  if (failures.length) process.exit(1)
  console.log(`No machine-local paths added between ${base.slice(0, 12)} and ${head}.`)
}
