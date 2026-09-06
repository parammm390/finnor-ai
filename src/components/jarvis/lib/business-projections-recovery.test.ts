import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const source = readFileSync(fileURLToPath(new URL("./business-projections.tsx", import.meta.url)), "utf8")

describe("business projection realtime recovery", () => {
  it("keeps initial replay inside the bounded reconnect loop", () => {
    const runtime = source.slice(source.indexOf("void (async () =>"), source.indexOf("return () =>", source.indexOf("void (async () =>")))
    const loop = runtime.indexOf("while (!cancelled)")
    const replay = runtime.indexOf("await replay()")
    const recoveryStatus = runtime.indexOf('publishRealtimeStatus("polling"')
    const cacheMode = runtime.indexOf('cache.setRealtimeMode("polling")')
    const delay = runtime.indexOf("window.setTimeout")

    expect(loop).toBeGreaterThan(-1)
    expect(replay).toBeGreaterThan(loop)
    expect(recoveryStatus).toBeGreaterThan(replay)
    expect(cacheMode).toBeGreaterThan(replay)
    expect(cacheMode).toBeLessThan(recoveryStatus)
    expect(delay).toBeGreaterThan(recoveryStatus)
    expect(runtime).not.toContain("try { await replay() } catch")
  })
})
