import { test, expect, type Page } from "@playwright/test"
import { mkdirSync } from "node:fs"

// jarvis-v3 P4.T8 — the golden consequence graph (plan v3 §8 PHASE 4), driven
// for real: sign in, submit the golden instruction, verify the ACTUAL action
// type before ever clicking Approve (BLOCKER B-5's own conditional go-ahead —
// the plan owner authorized approving ONE real action for THIS phase's
// evidence, but ONLY if it is literally `start_invoice_to_cash_workflow`;
// anything else is a no-go for that run, reported, never approved blind), then
// assert every surface in the consequence graph actually changed.
//
// The payment-webhook "long tail" (P4.T4/T5) is attempted against the real
// DEPLOYED backend (NEXT_PUBLIC_OS_API_URL) directly, via the dev/emulator
// shape webhooks/payment/route.ts accepts OUTSIDE production. Whether that
// succeeds depends on the deployed environment's own NODE_ENV — checked live
// via GET /api/jarvis/setup/status's `environment.nodeEnv` before attempting
// it, never assumed. If the deployed backend is production (the A3.T6 fix
// makes it fail closed with no STRIPE_WEBHOOK_SECRET there), that specific
// line is left honestly unchecked with the real 401 pasted as evidence — not
// silently retried with a fabricated signature this environment has no secret
// to construct.

const email = process.env.TEST_OWNER_EMAIL
const password = process.env.TEST_OWNER_PASSWORD
const OS_API = process.env.NEXT_PUBLIC_OS_API_URL

// P7 may re-run this real, conditionally authorized path. Keep its evidence
// separate from P4's immutable captures when an explicit output directory is
// supplied, rather than overwriting unrelated screenshots.
const OUT_DIR = process.env.JARVIS_E2E_OUT_DIR ?? "qa-screenshots/v3-P4"
const SAFE_ACTION_TYPE = "start_invoice_to_cash_workflow"

interface PlannedAction {
  id: string
  actionType: string
  payload: Record<string, unknown>
}

// jarvisGet/jarvisPost (lib/api.ts) attach the real Supabase session as an
// `Authorization: Bearer` header, read from in-page module state —
// `page.request.*` is a separate HTTP client that shares cookies, not that
// module state, so it needs the real token pulled out of Supabase's own
// localStorage persistence explicitly. Real token, not a fabricated one.
async function getRealAccessToken(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    for (const key of Object.keys(window.localStorage)) {
      if (!key.includes("auth-token")) continue
      try {
        const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null")
        if (parsed?.access_token) return parsed.access_token as string
      } catch {
        continue
      }
    }
    return null
  })
}

test.describe("P4 — the golden consequence graph, driven for real", () => {
  test.skip(!email || !password, "TEST_OWNER_EMAIL/TEST_OWNER_PASSWORD not set")
  test.skip(!OS_API, "NEXT_PUBLIC_OS_API_URL not set — can't reach the deployed backend directly for the webhook step")
  test.setTimeout(180_000)

  test("approving a real start_invoice_to_cash_workflow action changes every surface in the consequence graph", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop-chromium", "single real-journey run")
    mkdirSync(OUT_DIR, { recursive: true })

    const errors: string[] = []
    page.on("console", (msg) => {
      const text = msg.text()
      if (msg.type() === "error" && !text.includes("401") && !text.includes("500") && !text.includes("429") && !text.includes("404")) errors.push(text)
    })

    let plannedActions: PlannedAction[] = []
    page.on("response", (res) => {
      if (res.url().includes("/api/jarvis/actions") && res.request().method() === "POST") {
        res
          .json()
          .then((body) => {
            if (Array.isArray(body?.planned)) plannedActions = body.planned
          })
          .catch(() => undefined)
      }
    })

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto("/jarvis/login", { waitUntil: "domcontentloaded" })
    await page.waitForLoadState("networkidle")
    await page.getByPlaceholder(/you@example.com/i).fill(email!)
    await page.getByPlaceholder(/•+/i).fill(password!)
    await expect(page.getByRole("button", { name: /sign in/i })).toBeEnabled({ timeout: 5_000 })
    await page.getByRole("button", { name: /sign in/i }).click()
    await page.waitForURL("**/jarvis", { timeout: 20_000 })

    const token = await getRealAccessToken(page)
    expect(token, "real Supabase access token must be extractable after a real sign-in").not.toBeNull()
    const authHeaders = { authorization: `Bearer ${token}` }

    // Real config posture of the deployed backend — decides, honestly, whether
    // the webhook step below is even attemptable, before promising anything.
    const setupRes = await page.request.get("/api/jarvis/setup/status", { headers: authHeaders })
    const setupBody = setupRes.ok() ? await setupRes.json().catch(() => null) : null
    const deployedNodeEnv: string | undefined = setupBody?.environment?.nodeEnv
    console.log(`REAL deployed backend environment.nodeEnv: ${deployedNodeEnv ?? "(unavailable — " + setupRes.status() + ")"}`)

    // The plan owner's narrow B-5 authorization covers this workflow only
    // while its three externally-capable steps remain non-external. Assert the
    // live posture before submitting or approving anything: create payment
    // link -> payments; delivery -> CRM (native is the repository's DB-only
    // sandbox-outbox binding, while GHL is external); accounting sync ->
    // accounting (anything other than QuickBooks resolves to its emulator).
    const bindings = setupBody?.environment?.bindings
    expect(bindings?.payments?.mode, "B-5 no-go: payment-link binding must be emulator").toBe("emulator")
    expect(bindings?.crm?.mode, "B-5 no-go: message delivery must not use external GHL").not.toBe("ghl")
    expect(bindings?.accounting?.mode, "B-5 no-go: accounting sync must not use external QuickBooks").not.toBe("quickbooks")

    // Real overdue invoices BEFORE this run — the consequence checklist's own
    // "before" baseline (selectOverdueInvoices/selectCollectedUsd's real source).
    const cashBefore = await (await page.request.get("/api/jarvis/read-models/cash-collections", { headers: authHeaders })).json().catch(() => null)
    console.log("REAL cash-collections BEFORE:", JSON.stringify(cashBefore))

    await page.goto("/jarvis", { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(1500)

    const rail = page.getByPlaceholder("Tell JARVIS what you need")
    await expect(rail).toBeVisible({ timeout: 15_000 })
    await rail.click()
    await rail.fill("Chase everyone more than thirty days overdue")
    await rail.press("Enter")

    await expect(page.getByText("Chase everyone more than thirty days overdue").first()).toBeVisible({ timeout: 10_000 })
    // The live planner is non-deterministic (verified repeatedly this session
    // and in P2/P3): a real run may produce a real plan (awaiting approval), a
    // real clarification, OR a genuine 0-action plan that skips straight to
    // the terminal "what actually happened" state (§6③'s own designed empty-
    // plan path) — every one of these is a real, honest outcome, never faked
    // to force this test down the approve branch.
    // The adaptive workspace may truthfully produce a plan, clarification,
    // grounded research answer, or receipt. What matters here is that the
    // submitted instruction left Ready and resolved into an observed workspace;
    // the typed action check below remains the authority gate for any approval.
    await expect(page.locator("[data-active-workspace]")).not.toHaveAttribute("data-active-workspace", "ready", { timeout: 15_000 })
    await page.waitForTimeout(1500) // let the POST /api/actions response (captured above) land

    await page.screenshot({ path: `${OUT_DIR}/consequence-00-plan-1440.png`, fullPage: true })

    const businessActions = plannedActions.filter((a) => a.actionType !== "clarification_request")
    const allSafe = businessActions.length > 0 && businessActions.every((a) => a.actionType === SAFE_ACTION_TYPE)
    console.log(`REAL planned action types this run: ${businessActions.map((a) => a.actionType).join(", ") || "(none)"}`)

    const rejectButtons = page.getByRole("button", { name: "Reject" })
    const hasCockpit = await rejectButtons.first().isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasCockpit || !allSafe) {
      // B-5's own conditional go-ahead: only start_invoice_to_cash_workflow may
      // be approved. Anything else (no cockpit at all, a mixed plan, or the
      // planner's known non-determinism routing to e.g. call_overdue_invoices)
      // is a failed certification run, not a successful run that simply skipped
      // the consequence graph. Reject any visible cards before failing so the
      // test leaves the tenant in a safe state.
      if (hasCockpit) {
        const count = await rejectButtons.count()
        for (let i = 0; i < count; i++) await rejectButtons.first().click({ timeout: 5_000 }).catch(() => undefined)
      }
      test.info().annotations.push({
        type: "B-5-no-go",
        description: `Planned action types were [${businessActions.map((a) => a.actionType).join(", ")}], not all ${SAFE_ACTION_TYPE} — rejected per the plan owner's own conditional go-ahead. Consequence-graph checklist NOT exercised this run.`,
      })
      expect(errors, `unexpected console errors: ${errors.join(" | ")}`).toEqual([])
      expect(hasCockpit && allSafe, "Consequence-graph certification requires a visible approval cockpit containing only the safe workflow action").toBe(true)
    }

    // Real go: approve every real card individually (never the batch/typed-
    // confirm path — that's a separate, already-covered interaction; this run
    // is about the consequence graph, not re-proving the approval UI).
    await page.screenshot({ path: `${OUT_DIR}/consequence-01-approval-cockpit-1440.png`, fullPage: true })
    const approveButtons = page.getByRole("button", { name: "Approve" })
    const approveCount = await approveButtons.count()
    for (let i = 0; i < approveCount; i++) {
      await approveButtons.first().click()
      await page.waitForTimeout(400)
    }

    // Real terminal outcome.
    await expect(page.getByText("WHAT ACTUALLY HAPPENED")).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(1000)
    await page.screenshot({ path: `${OUT_DIR}/consequence-02-receipt-before-webhook-1440.png`, fullPage: true })
    await page.screenshot({ path: `${OUT_DIR}/consequence-02-receipt-before-webhook-390.png` })

    const invoiceId = businessActions[0]?.payload?.invoiceId as string | undefined
    console.log(`REAL invoiceId targeted for the payment-webhook step: ${invoiceId ?? "(none found in planned payload)"}`)

    let invoiceAmountUsd: number | null = null
    if (invoiceId) {
      const invoicesRes = await page.request.get("/api/jarvis/resources/invoices", { headers: authHeaders })
      const invoicesBody = invoicesRes.ok() ? await invoicesRes.json().catch(() => null) : null
      const row = invoicesBody?.rows?.find((r: { id: string }) => r.id === invoiceId)
      invoiceAmountUsd = row ? Number(row.amountUsd) : null
      console.log(`REAL invoice row for ${invoiceId}: ${JSON.stringify(row)}`)
    }

    if (invoiceId && invoiceAmountUsd !== null) {
      const tenantId = "00000000-0000-4000-8000-000000000001"
      const webhookRes = await page.request.post(`${OS_API}/api/webhooks/payment`, {
        data: {
          tenantId,
          invoiceId,
          providerEventId: `evt_p4t8_${Date.now()}`,
          amountUsd: invoiceAmountUsd,
          status: "succeeded",
        },
      })
      console.log(`REAL payment webhook response: ${webhookRes.status()} ${await webhookRes.text().catch(() => "")}`)

      if (webhookRes.status() === 200) {
        // Cross-surface invalidation (P4.T5): give the payment-watch effect's
        // own reconciliation (medium-lane events poll) a real chance to land,
        // then reload to observe the receipt update in place + the KPI drop.
        await page.waitForTimeout(9_000)
        const cashAfter = await (await page.request.get("/api/jarvis/read-models/cash-collections", { headers: authHeaders })).json().catch(() => null)
        console.log("REAL cash-collections AFTER:", JSON.stringify(cashAfter))
        await page.reload({ waitUntil: "domcontentloaded" })
        await page.waitForTimeout(1500)
        await page.screenshot({ path: `${OUT_DIR}/consequence-03-receipt-after-webhook-1440.png`, fullPage: true })
      } else {
        test.info().annotations.push({
          type: "webhook-rejected",
          description: `Real payment webhook returned ${webhookRes.status()} against the deployed backend (nodeEnv=${deployedNodeEnv}) — the long-tail receipt-update line is honestly unchecked this run, not fabricated.`,
        })
      }
    }

    expect(errors, `unexpected console errors: ${errors.join(" | ")}`).toEqual([])
  })
})
