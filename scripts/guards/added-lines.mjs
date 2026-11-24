import { spawnSync } from "node:child_process"

export function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`)
  return result.stdout
}

export function addedLines(base, head, paths = []) {
  const lines = []
  let file = null
  let next = 0
  for (const line of git(["diff", "--no-color", "--no-ext-diff", "--unified=0", "--find-renames", "--diff-filter=ACMR", base, head, "--", ...paths]).split("\n")) {
    if (line.startsWith("+++ ")) file = line === "+++ /dev/null" ? null : line.slice(6)
    else if (line.startsWith("@@")) next = Number(/\+(\d+)/.exec(line)[1])
    else if (line.startsWith("+") && file) lines.push({ file, line: next++, text: line.slice(1) })
  }
  return lines
}

export function rangeFromArgs(argv) {
  return { base: argv[2] ?? git(["merge-base", "origin/main", "HEAD"]).trim(), head: argv[3] ?? "HEAD" }
}

export function unexpiredException(text, marker, today = new Date().toISOString().slice(0, 10)) {
  const exception = new RegExp(`${marker}: .+; expires=(\\d{4}-\\d{2}-\\d{2}); approved=@[\\w-]+`).exec(text)
  return exception ? { live: exception[1] >= today, expires: exception[1] } : null
}
