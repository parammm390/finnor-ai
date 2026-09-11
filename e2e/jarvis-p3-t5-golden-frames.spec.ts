import { mkdirSync, writeFileSync } from "node:fs"
import { expect, test, type Page } from "@playwright/test"

// P3.T5 — one coherent, source-honest Golden Frame set. Home states use the
// existing visibly labelled Thread fixture harness; private operational routes
// use their real unauthenticated boundary because this environment has no
// tenant session. No response body is invented here and no auth state is
// simulated.

const OUT_DIR = "evidence/jarvis-p3-t5-v6"

const FRAMES = [
  { id: "01-home-ready", route: "/jarvis/next?fixture=rest", width: 1440, height: 1000, kind: "fixture", scene: "ready", marker: "[data-jarvis-thread][data-source='fixture']" },
  { id: "02-home-listening", route: "/jarvis/next?fixture=listening", width: 1440, height: 1000, kind: "fixture", scene: "listening", marker: "[data-jarvis-thread][data-source='fixture']" },
  { id: "03-home-building-plan", route: "/jarvis/next?fixture=plan", width: 1440, height: 1000, kind: "fixture", scene: "plan", marker: "[data-jarvis-thread][data-source='fixture']" },
  { id: "04-home-needs-approval", route: "/jarvis/next?fixture=approval", width: 1440, height: 1000, kind: "fixture", scene: "approval", marker: "[data-jarvis-thread][data-source='fixture']" },
  { id: "05-home-working", route: "/jarvis/next?fixture=execution", width: 1440, height: 1000, kind: "fixture", scene: "working", marker: "[data-jarvis-thread][data-source='fixture']" },
  { id: "06-home-outcome", route: "/jarvis/next?fixture=receipt", width: 1440, height: 1000, kind: "fixture", scene: "outcome", marker: "[data-jarvis-thread][data-source='fixture']" },
  { id: "07-work-causal-spine", route: "/jarvis/work", width: 1440, height: 900, kind: "boundary", scene: null, marker: "[data-jarvis-work]" },
  { id: "08-customer-household-360", route: "/jarvis/customers", width: 1440, height: 900, kind: "boundary", scene: null, marker: "[data-jarvis-household-360]" },
  { id: "09-schedule-dispatcher-map", route: "/jarvis/schedule", width: 1440, height: 900, kind: "boundary", scene: null, marker: "[data-jarvis-dispatch-field]" },
  { id: "10-my-day-mobile-boundary", route: "/jarvis/schedule", width: 390, height: 844, kind: "boundary", scene: null, marker: "[data-jarvis-dispatch-field]" },
  { id: "11-money-cash-pressure", route: "/jarvis/money", width: 1440, height: 900, kind: "boundary", scene: null, marker: "[data-jarvis-cash-pressure]" },
  { id: "12-agents-fleet", route: "/jarvis/agents", width: 1440, height: 900, kind: "boundary", scene: null, marker: "[data-jarvis-agent-fleet]" },
] as const

type FrameMetrics = {
  id: string
  route: string
  kind: "fixture" | "boundary"
  viewport: { width: number; height: number }
  scrollWidth: number
  bodyWidth: number
  visibleHeadings: string[]
  topLevelRegions: number
  largestRegions: Array<{ tag: string; label: string; width: number; height: number; area: number }>
  rawJson: boolean
  sourceLabels: string[]
  truthMarkers: string[]
  privateResourceRequests: string[]
  unexpectedErrors: string[]
}

function filterUnexpectedErrors(errors: string[]): string[] {
  return errors.filter((message) => !message.includes("Failed to load resource: the server responded with a status of 401 (Unauthorized)"))
}

async function readMetrics(page: Page, frame: (typeof FRAMES)[number], privateResourceRequests: string[], errors: string[]): Promise<FrameMetrics> {
  return page.evaluate(({ id, route, kind, width, height, privateRequests, pageErrors }) => {
    const visible = (element: Element) => {
      const node = element as HTMLElement
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0
    }
    const regionRoot = document.querySelector("main") ?? document.body
    const regions = [...regionRoot.children].filter(visible).map((element) => {
      const rect = element.getBoundingClientRect()
      return {
        tag: element.tagName.toLowerCase(),
        label: element.getAttribute("aria-label") ?? element.querySelector("h1,h2")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        area: Math.round(rect.width * rect.height),
      }
    }).sort((a, b) => b.area - a.area)
    const bodyText = document.body.innerText.replace(/\s+/g, " ").trim()
    const sourceLabels = [...document.querySelectorAll<HTMLElement>("[data-source], [data-fixture-journey-state], .j-chip")]
      .map((element) => element.textContent?.replace(/\s+/g, " ").trim() ?? element.getAttribute("data-source") ?? "")
      .filter(Boolean)
      .slice(0, 20)
    const truthMarkers = [...document.querySelectorAll<HTMLElement>("[role='status'], [data-source-state], [data-agent-status], [data-provider-status]")]
      .map((element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "")
      .filter(Boolean)
      .slice(0, 20)
    return {
      id,
      route,
      kind,
      viewport: { width, height },
      scrollWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      visibleHeadings: [...document.querySelectorAll<HTMLElement>("h1,h2")].filter(visible).map((element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "").filter(Boolean),
      topLevelRegions: regions.length,
      largestRegions: regions.slice(0, 4),
      rawJson: /\{\s*["'][A-Za-z][\w-]*["']\s*:/.test(bodyText),
      sourceLabels,
      truthMarkers,
      privateResourceRequests: privateRequests,
      unexpectedErrors: pageErrors,
    }
  }, {
    id: frame.id,
    route: frame.route,
    kind: frame.kind,
    width: frame.width,
    height: frame.height,
    privateRequests: privateResourceRequests,
    pageErrors: filterUnexpectedErrors(errors),
  })
}

test.describe("P3.T5 — 12 Golden Frames", () => {
  test.setTimeout(120_000)

  test("captures one source-honest, responsive frame for every §18 object", async ({ page, context }) => {
    test.skip(test.info().project.name !== "desktop-chromium", "explicit Golden Frame viewports")
    await context.clearCookies()
    mkdirSync(OUT_DIR, { recursive: true })

    const allMetrics: FrameMetrics[] = []
    for (const frame of FRAMES) {
      const errors: string[] = []
      const privateResourceRequests: string[] = []
      page.removeAllListeners("console")
      page.removeAllListeners("pageerror")
      page.removeAllListeners("request")
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("request", (request) => {
        const url = request.url()
        if (["/api/jarvis/read-models/work-cases", "/api/jarvis/resources/households", "/api/jarvis/read-models/household-360", "/api/jarvis/dispatch/map", "/api/jarvis/technician/my-day", "/api/jarvis/resources/invoices", "/api/jarvis/read-models/cash-collections"].some((needle) => url.includes(needle))) {
          privateResourceRequests.push(url.replace(/^https?:\/\/[^/]+/, ""))
        }
      })

      await page.setViewportSize({ width: frame.width, height: frame.height })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.goto(frame.route, { waitUntil: "domcontentloaded" })
      await expect(page.locator(frame.marker)).toBeVisible()
      if (frame.scene) await expect(page.locator(`[data-jarvis-thread][data-command-canvas-scene='${frame.scene}']`)).toBeVisible()
      if (frame.kind === "boundary") await page.waitForTimeout(700)
      const metrics = await readMetrics(page, frame, privateResourceRequests, errors)

      expect(metrics.scrollWidth).toBeLessThanOrEqual(frame.width)
      expect(metrics.bodyWidth).toBeLessThanOrEqual(frame.width)
      expect(metrics.rawJson).toBe(false)
      expect(metrics.unexpectedErrors).toEqual([])
      if (frame.kind === "fixture") expect(metrics.sourceLabels.some((label) => label.includes("FIXTURE"))).toBe(true)
      if (frame.id === "07-work-causal-spine") await expect(page.getByRole("status")).toContainText("Sign in to inspect tenant Work")
      if (frame.id === "08-customer-household-360") await expect(page.getByRole("status")).toContainText("Sign in to inspect the tenant Household 360")
      if (frame.id === "09-schedule-dispatcher-map" || frame.id === "10-my-day-mobile-boundary") expect(await page.getByRole("heading", { name: "Dispatch Field is unavailable" }).count()).toBe(1)
      if (frame.id === "11-money-cash-pressure") expect(await page.getByRole("heading", { name: "Cash Pressure is unavailable" }).count()).toBe(1)
      if (frame.id === "12-agents-fleet") {
        expect(await page.getByRole("heading", { name: "Worker identity, assignment, and learning from backend truth." }).count()).toBe(1)
        expect(await page.locator("[data-agent-fleet-rail] [data-agent-key]").count()).toBe(0)
        expect(await page.getByRole("status")).toContainText("Sign in to inspect the governed workforce")
      }

      await page.screenshot({ path: `${OUT_DIR}/${frame.id}-${frame.width}x${frame.height}.png`, fullPage: true })
      allMetrics.push(metrics)
    }

    expect(allMetrics).toHaveLength(12)
    expect(new Set(allMetrics.map((metric) => metric.id)).size).toBe(12)
    writeFileSync(`${OUT_DIR}/after-metrics.json`, JSON.stringify({ task: "P3.T5", date: "2026-08-08", frames: allMetrics }, null, 2))
  })
})
